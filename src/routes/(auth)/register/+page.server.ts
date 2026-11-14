/**
 * Registration flow (AD-1946 hardened).
 *
 *  1. Bot checks: honeypot + minimum fill time + Cloudflare Turnstile + per-IP / per-mailbox rate limits.
 *     A honeypot/timing hit gets a fake "check your email" so bots get no signal.
 *  2. Validate inputs (see $lib/server/auth/signup_validation): real first+last name, plausible company,
 *     non-disposable email, valid phone (E.164), resolvable website, password rules.
 *  3. Reject duplicates (Gmail dot/+tag variants count as the same mailbox) and existing Salesforce Contacts.
 *  4. Create the LOCAL account + user in one transaction, flagged email_verification_pending.
 *  5. Email a verification link. NOTHING is created in Salesforce and no session is issued yet.
 *  6. /register/verify (on click) clears the flag, runs finalizeSignup (S3 folders, Salesforce Account +
 *     Contact) and signs the user in.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth/password';
import { logError, describeError } from '$lib/server/error_log';
import { resolvePostAuthPath, safeNextUrl } from '$lib/server/auth/redirects';
import { findContactByEmail } from '$lib/server/salesforce';
import { env } from '$env/dynamic/private';
import { env as publicEnv } from '$env/dynamic/public';
import { hitRateLimit } from '$lib/server/admin/rate_limit';
import { verifyTurnstile } from '$lib/server/auth/turnstile';
import { createVerificationToken } from '$lib/server/auth/email_verification';
import { sendVerificationEmail } from '$lib/server/salesforce/email';
import { domainResolves, hostFromWebsite } from '$lib/server/auth/domain_check';
import {
	validateFullName, validateCompanyName, validateEmail, validatePhone, validateWebsite,
	canonicalEmailKey, looksLikeBot
} from '$lib/server/auth/signup_validation';

const SIGNUPS_PER_IP_PER_HOUR = 5;
const SIGNUPS_PER_MAILBOX_PER_HOUR = 3;

interface FormEcho {
	name: string;
	company: string;
	email: string;
	phone: string;
	website: string;
	// True only when the failure is a duplicate email — lets the page show a
	// "Sign in instead" link. Defaulted on every echo so it's present on every
	// fail() shape (keeps ActionData a single, narrowable type).
	emailTaken: boolean;
}

function echo(data: FormData): FormEcho {
	return {
		name: String(data.get('name') ?? ''),
		company: String(data.get('company') ?? ''),
		email: String(data.get('email') ?? ''),
		phone: String(data.get('phone') ?? ''),
		website: String(data.get('website') ?? ''),
		emailTaken: false
	};
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.user) throw redirect(303, resolvePostAuthPath(url.searchParams.get('next')));
	return { next: safeNextUrl(url.searchParams.get('next')), turnstileSiteKey: publicEnv.PUBLIC_TURNSTILE_SITE_KEY ?? '' };
};

export const actions: Actions = {
	register: async ({ request, getClientAddress, url }) => {
		const data = await request.formData();
		const back = echo(data);
		const name = back.name.trim().replace(/\s+/g, ' ');
		const company = back.company.trim().replace(/\s+/g, ' ');
		const email = back.email.trim().toLowerCase();
		const website = back.website.trim();
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');
		const ip = (() => { try { return getClientAddress(); } catch { return 'unknown'; } })();
		const checkEmailPath = `/register/check-email?email=${encodeURIComponent(email)}`;

		// ─── 1. Bot checks ────────────────────────────────────────────
		// Honeypot / too-fast / no-JS submissions: pretend it worked so the bot learns nothing.
		if (looksLikeBot({ honeypot: String(data.get('fax_number') ?? ''), startedAt: String(data.get('_t') ?? '') })) {
			throw redirect(303, checkEmailPath);
		}
		const ipLimit = await hitRateLimit(`signup:ip:${ip}`, SIGNUPS_PER_IP_PER_HOUR, 3600);
		if (!ipLimit.allowed) {
			return fail(429, { ...back, error: 'Too many signup attempts. Please try again later.' });
		}
		if (!(await verifyTurnstile(String(data.get('cf-turnstile-response') ?? ''), ip))) {
			return fail(400, { ...back, error: 'We could not verify that you are human. Please refresh the page and try again.' });
		}

		// ─── 2. Validation ────────────────────────────────────────────
		if (!name || !company || !email || !back.phone.trim() || !website || !password || !confirm) {
			return fail(400, { ...back, error: 'All fields are required.' });
		}
		const nameErr = validateFullName(name);
		if (nameErr) return fail(400, { ...back, error: nameErr });
		const companyErr = validateCompanyName(company);
		if (companyErr) return fail(400, { ...back, error: companyErr });
		const emailErr = validateEmail(email, (env.SIGNUP_BLOCKED_EMAIL_DOMAINS ?? '').split(','));
		if (emailErr) return fail(400, { ...back, error: emailErr });
		const phoneRes = validatePhone(back.phone);
		if (!phoneRes.ok) return fail(400, { ...back, error: phoneRes.error });
		const phone = phoneRes.e164;
		const websiteErr = validateWebsite(website);
		if (websiteErr) return fail(400, { ...back, error: websiteErr });
		const host = hostFromWebsite(website);
		if (!host || !(await domainResolves(host))) {
			return fail(400, { ...back, error: 'We could not find that website. Please enter your real company website (e.g. acme.com).' });
		}
		if (password !== confirm) {
			return fail(400, { ...back, error: 'Passwords do not match.' });
		}
		if (password.length < 8) {
			return fail(400, { ...back, error: 'Password must be at least 8 characters.' });
		}

		// ─── 3. Duplicate checks ──────────────────────────────────────
		// Same mailbox: exact email, or (Gmail) the same address ignoring dots / +tags.
		const canonical = canonicalEmailKey(email);
		const existing = await sql<{ id: string; email: string; pending: boolean }[]>`
			SELECT id, email, email_verification_pending AS pending FROM users
			WHERE email = ${email}
			   OR (email ~* '@(gmail|googlemail)\.com$'
			       AND replace(split_part(split_part(lower(email), '@', 1), '+', 1), '.', '') || '@gmail.com' = ${canonical})
			LIMIT 1`;
		if (existing.length) {
			// A signup that never confirmed: just send a fresh link (rate-limited) instead of "already exists".
			if (existing[0].pending && existing[0].email === email) {
				const lim = await hitRateLimit(`signup:mailbox:${canonical}`, SIGNUPS_PER_MAILBOX_PER_HOUR, 3600);
				if (lim.allowed) await sendNewVerification(existing[0].id, email, url.origin).catch(() => {});
				throw redirect(303, checkEmailPath);
			}
			return fail(409, {
				...back,
				error: 'An account with this email already exists.',
				emailTaken: true
			});
		}
		const mailboxLimit = await hitRateLimit(`signup:mailbox:${canonical}`, SIGNUPS_PER_MAILBOX_PER_HOUR, 3600);
		if (!mailboxLimit.allowed) {
			return fail(429, { ...back, error: 'Too many signup attempts for this email. Please try again later.' });
		}

		// Salesforce duplicate-Contact check — before creating anything (see git history for why).
		const existingContact = await findContactByEmail(email);
		if (existingContact) {
			return fail(409, {
				...back,
				error:
					'A Salesforce contact already exists for this email. Please use a different email, or log in if this is your account.',
				emailTaken: true
			});
		}

		// ─── 4. DB transaction: create account + user (unverified) ────
		const passwordHash = await hashPassword(password);
		let accountId: string;
		let userId: string;
		try {
			[accountId, userId] = await sql.begin(async (sql) => {
				const [account] = await sql<{ id: string }[]>`
					INSERT INTO accounts (name, email, phone, website)
					VALUES (${company}, ${email}, ${phone}, ${website})
					RETURNING id
				`;
				const [user] = await sql<{ id: string }[]>`
					INSERT INTO users (email, display_name, password_hash, account_id, role, last_login_at, email_verification_pending)
					VALUES (${email}, ${name}, ${passwordHash}, ${account.id}, 'owner', NULL, true)
					RETURNING id
				`;
				return [account.id, user.id];
			});
		} catch (e) {
			// A concurrent signup can slip past the SELECT above and only collide on the UNIQUE constraint.
			if (e && typeof e === 'object' && (e as { code?: string }).code === '23505') {
				return fail(409, {
					...back,
					error: 'An account with this email already exists.',
					emailTaken: true
				});
			}
			const desc = describeError(e);
			await logError({
				source: 'register',
				operation: 'create_account_and_user',
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { email, companyName: company }
			});
			return fail(500, {
				...back,
				error: 'Could not create your account right now. Please try again.'
			});
		}

		// ─── 5. Verification email ────────────────────────────────────
		try {
			await sendNewVerification(userId, email, url.origin, accountId);
		} catch {
			// Couldn't deliver — remove the unverified rows so the user can retry cleanly.
			await sql`DELETE FROM users WHERE id = ${userId}`.catch(() => {});
			await sql`DELETE FROM accounts WHERE id = ${accountId}`.catch(() => {});
			return fail(502, { ...back, error: 'We could not send your confirmation email. Please check the address and try again.' });
		}

		throw redirect(303, checkEmailPath);
	}
};

async function sendNewVerification(userId: string, email: string, origin: string, accountId?: string): Promise<void> {
	const raw = await createVerificationToken(userId, email);
	await sendVerificationEmail(email, `${origin}/register/verify?token=${raw}`, { userId, accountId });
}
