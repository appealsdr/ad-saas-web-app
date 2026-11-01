/**
 * Registration flow.
 *
 *  1. Validate inputs:
 *       - Required: name, company, email, phone, website, password, confirm
 *       - email matches a minimal regex, password ≥ 8 chars, passwords match
 *       - phone has ≥ 7 digits (lenient — accept international formats)
 *       - website looks like a domain or URL (prepended with https:// before SF)
 *  2. Reject if a user already exists with that email.
 *  3. Inside ONE Postgres transaction:
 *       a. INSERT accounts row (name=company, email, phone, website).
 *       b. INSERT users row, account_id → the new account, password hashed (scrypt).
 *  4. Best-effort Salesforce sync (non-blocking for registration success):
 *       a. Create Account in SF (Name, Primary_Email__c, Phone, Website, Start_Date__c).
 *       b. Create Contact in SF (FirstName, LastName, Email, Phone) linked via AccountId.
 *       c. UPDATE local accounts.sfdc_account_id and users.sfdc_*_id with the IDs.
 *     If SF fails (auth not configured, network, validation, etc.) enqueue
 *     Account + Contact rows into sfdc_sync_queue for the background worker
 *     to retry. The registration itself still succeeds.
 *  5. Create a DB-backed session row, set the cookie, redirect to /dashboard.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth/password';
import { createSession } from '$lib/server/auth/session';
import { logError, describeError } from '$lib/server/error_log';
import { setSessionCookie } from '$lib/server/auth/cookie';
import { resolvePostAuthPath, safeNextUrl } from '$lib/server/auth/redirects';
import {
	createSalesforceAccountAndContact,
	enqueueAccountContactSync,
	findContactByEmail,
	splitFullName
} from '$lib/server/salesforce';
import { ensureAccountFolders } from '$lib/server/storage/s3-paths';
import { ensureOwnerAccountContact } from '$lib/server/account/contacts';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Lenient — at least 7 digits, otherwise we'd reject too many real numbers.
const PHONE_DIGITS_MIN = 7;
// Allow either a full URL or a bare domain. We prepend https:// for SF.
const WEBSITE_RE = /^(https?:\/\/)?([\w-]+\.)+[\w-]{2,}([/?#].*)?$/i;

const SESSION_COOKIE_MAX_AGE = 60 * 60 * 3; // 3h — must match auth/session.ts TTL

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
	return { next: safeNextUrl(url.searchParams.get('next')) };
};

export const actions: Actions = {
	register: async ({ request, cookies, getClientAddress, url }) => {
		const data = await request.formData();
		const back = echo(data);
		const name = back.name.trim();
		const company = back.company.trim();
		const email = back.email.trim().toLowerCase();
		const phone = back.phone.trim();
		const website = back.website.trim();
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');

		// ─── 1. Validation ────────────────────────────────────────────
		if (!name || !company || !email || !phone || !website || !password || !confirm) {
			return fail(400, { ...back, error: 'All fields are required.' });
		}
		if (!EMAIL_RE.test(email)) {
			return fail(400, { ...back, error: 'Please enter a valid email address.' });
		}
		const phoneDigits = phone.replace(/\D/g, '');
		if (phoneDigits.length < PHONE_DIGITS_MIN) {
			return fail(400, { ...back, error: 'Please enter a valid phone number.' });
		}
		if (!WEBSITE_RE.test(website)) {
			return fail(400, {
				...back,
				error: 'Please enter a valid website (e.g. acme.com or https://acme.com).'
			});
		}
		if (password !== confirm) {
			return fail(400, { ...back, error: 'Passwords do not match.' });
		}
		if (password.length < 8) {
			return fail(400, { ...back, error: 'Password must be at least 8 characters.' });
		}

		// ─── 2. Duplicate check ───────────────────────────────────────
		const existing = await sql<{ id: string }[]>`
			SELECT id FROM users WHERE email = ${email} LIMIT 1
		`;
		if (existing.length) {
			return fail(409, {
				...back,
				error: 'An account with this email already exists.',
				emailTaken: true
			});
		}

		// ─── 2b. Salesforce duplicate-Contact check ────────────────────
		// Catch this before creating anything — otherwise Salesforce's own
		// duplicate rule rejects the Contact create AFTER the Account was
		// already created, leaving an orphaned Account and a local account
		// row with no sfdc_account_id (surfaces later as a checkout failure).
		const existingContact = await findContactByEmail(email);
		if (existingContact) {
			return fail(409, {
				...back,
				error:
					'A Salesforce contact already exists for this email. Please use a different email, or log in if this is your account.',
				emailTaken: true
			});
		}

		// ─── 3. DB transaction: create account + user ─────────────────
		const passwordHash = await hashPassword(password);
		let accountId: string;
		let userId: string;
		let accountCreatedAt: Date;
		try {
			[accountId, userId, accountCreatedAt] = await sql.begin(async (sql) => {
				const [account] = await sql<{ id: string; created_at: Date }[]>`
					INSERT INTO accounts (name, email, phone, website)
					VALUES (${company}, ${email}, ${phone}, ${website})
					RETURNING id, created_at
				`;
				const [user] = await sql<{ id: string }[]>`
					INSERT INTO users (email, display_name, password_hash, account_id, role, last_login_at)
					VALUES (${email}, ${name}, ${passwordHash}, ${account.id}, 'owner', now())
					RETURNING id
				`;
				return [account.id, user.id, account.created_at];
			});
		} catch (e) {
			// A concurrent signup can slip past the SELECT check above and only
			// collide on the `users.email` / `accounts.email` UNIQUE constraint
			// (Postgres error 23505). Surface the same friendly duplicate message
			// instead of a generic 500.
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

		// ─── 3b. Reserve S3 folders for this account (best-effort) ────
		// Writes `<root>/<accountId>/.placeholder` and `<root>/<accountId>/invoices/.placeholder`
		// so the AWS console shows the directory tree from day one. Failures
		// are swallowed inside ensureAccountFolders — never blocks registration.
		await ensureAccountFolders(accountId);

		// ─── 4. Salesforce sync (best-effort) ─────────────────────────
		const { firstName, lastName } = splitFullName(name);
		const sfInput = {
			companyName: company,
			firstName,
			lastName,
			email,
			phone,
			website,
			startDate: accountCreatedAt
		};
		const sfResult = await createSalesforceAccountAndContact(sfInput, { userId, accountId });

		if (sfResult.ok) {
			try {
				await sql.begin(async (sql) => {
					await sql`
						UPDATE accounts SET sfdc_account_id = ${sfResult.sfdcAccountId}
						WHERE id = ${accountId}
					`;
					await sql`
						UPDATE users
						SET sfdc_contact_id = ${sfResult.sfdcContactId},
						    sfdc_account_id = ${sfResult.sfdcAccountId}
						WHERE id = ${userId}
					`;
				});
			} catch (e) {
				// Local rows + real SF IDs exist; we just couldn't link them.
				// A reconcile job can patch using the SF IDs in this log entry.
				const desc = describeError(e);
				await logError({
					source: 'register',
					operation: 'persist_sfdc_ids',
					userId,
					accountId,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: {
						sfdcAccountId: sfResult.sfdcAccountId,
						sfdcContactId: sfResult.sfdcContactId
					}
				});
			}
		} else {
			// SF sync itself already logged its own error_log row in sync.ts.
			// Try to queue for retry; if that also fails, log a 'warn' since
			// the user-facing registration is still fine.
			try {
				await enqueueAccountContactSync({
					accountRowId: accountId,
					userRowId: userId,
					input: sfInput,
					failureReason: sfResult.error
				});
			} catch (e) {
				const desc = describeError(e);
				await logError({
					source: 'register',
					operation: 'enqueue_sfdc_sync',
					severity: 'warn',
					userId,
					accountId,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: { originalSfError: sfResult.error, originalSfErrorCode: sfResult.errorCode }
				});
			}
		}

		await ensureOwnerAccountContact(accountId, userId);

		// ─── 5. Session ───────────────────────────────────────────────
		const ipAddress = getClientAddress();
		const userAgent = request.headers.get('user-agent') ?? undefined;
		const { rawToken } = await createSession(userId, { ipAddress, userAgent });

		setSessionCookie(cookies, { url }, rawToken, SESSION_COOKIE_MAX_AGE);

		const nextFromForm = String(data.get('next') ?? '');
		const nextFromUrl = url.searchParams.get('next');
		throw redirect(303, resolvePostAuthPath(nextFromForm || nextFromUrl));
	}
};
