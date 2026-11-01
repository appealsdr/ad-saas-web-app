/**
 * Login flow — real authentication against the users table.
 *
 *  1. Validate form input (email, password present + valid shape).
 *  2. Look up user by email.
 *  3. Verify the submitted password against `users.password_hash` (scrypt).
 *     - If user doesn't exist OR has no password (OAuth-only) OR is_active=false,
 *       still run a scrypt comparison against a dummy hash. This equalizes
 *       request timing so an attacker can't tell from response latency
 *       whether the email exists.
 *  4. Update users.last_login_at.
 *  5. Create a DB-backed session, set the HttpOnly cookie, redirect.
 *
 *  Failed authentication ALWAYS returns the same generic message — never
 *  leak which field was wrong.
 */
import { fail, redirect } from '@sveltejs/kit';
import { createHash, randomBytes } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { hashPassword, verifyPassword } from '$lib/server/auth/password';
import { createSession } from '$lib/server/auth/session';
import { logError, describeError } from '$lib/server/error_log';
import { setSessionCookie } from '$lib/server/auth/cookie';
import { resolvePostAuthPath, safeNextUrl } from '$lib/server/auth/redirects';
import { updateSalesforceContact } from '$lib/server/salesforce/records';

const FORCED_RESET_TTL_MS = 60 * 60 * 1000; // 1h — matches password_reset_tokens convention

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 3; // 3h — matches auth/session.ts TTL
const GENERIC_AUTH_ERROR = 'Invalid email or password.';

const MAX_FAILED_ATTEMPTS = 3;
const LOCKOUT_MS = 24 * 60 * 60 * 1000; // 24h

// Pre-computed once, reused across every login that misses. Module-level so
// the cost is paid the first time anyone hits a missing-email login, not on
// every request. Keeps timing constant between "user not found" and "user
// found but wrong password" paths.
let dummyHashPromise: Promise<string> | null = null;
function getDummyHash(): Promise<string> {
	dummyHashPromise ??= hashPassword(
		'__dummy-hash-no-user-has-this__' + Math.random().toString(36)
	);
	return dummyHashPromise;
}

interface UserRow {
	id: string;
	email: string;
	password_hash: string | null;
	is_active: boolean;
	must_reset_password: boolean;
	failed_login_attempts: number;
	locked_until: string | null;
	sfdc_contact_id: string | null;
}

function formatLockedMessage(lockedUntil: Date): string {
	return `Too many failed attempts. Your account is locked until ${lockedUntil.toLocaleString()}.`;
}

export const load: PageServerLoad = async ({ locals, url }) => {
	// If they're already signed in, send them to wherever they were trying to go.
	if (locals.user) throw redirect(303, resolvePostAuthPath(url.searchParams.get('next')));
	// Expose the validated `next` so the form can echo it back as a hidden field.
	return {
		next: safeNextUrl(url.searchParams.get('next')),
		passwordReset: url.searchParams.get('reset') === '1',
		// Pre-fill the email when arriving from "Sign in instead" on /register.
		email: url.searchParams.get('email') ?? ''
	};
};

export const actions: Actions = {
	login: async ({ request, cookies, getClientAddress, url }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim().toLowerCase();
		const password = String(data.get('password') ?? '');

		// ─── 1. Shape validation ──────────────────────────────────────
		if (!email || !password) {
			return fail(400, { error: 'Email and password are required.', email });
		}
		if (!EMAIL_RE.test(email)) {
			return fail(400, { error: GENERIC_AUTH_ERROR, email });
		}

		// ─── 2. Look up user ──────────────────────────────────────────
		let row: UserRow | undefined;
		try {
			const rows = await sql<UserRow[]>`
				SELECT id, email, password_hash, is_active, must_reset_password,
				       failed_login_attempts, locked_until, sfdc_contact_id
				FROM users
				WHERE email = ${email}
				LIMIT 1
			`;
			row = rows[0];
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'login',
				operation: 'lookup_user',
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { email }
			});
			return fail(500, { error: 'Could not sign you in right now. Please try again.', email });
		}

		// ─── 2b. Locked out? ────────────────────────────────────────────
		if (row?.locked_until && new Date(row.locked_until) > new Date()) {
			return fail(423, { error: formatLockedMessage(new Date(row.locked_until)), email });
		}

		// ─── 3. Verify password — constant-time path ──────────────────
		// Always run a scrypt compare so timing is identical whether the user
		// exists or not. If the user has no password_hash (OAuth-only) treat
		// it like a missing user.
		const hashToCheck = row?.password_hash ?? (await getDummyHash());
		const passwordOk = await verifyPassword(password, hashToCheck);

		if (!row || !row.is_active || !row.password_hash || !passwordOk) {
			// Only real, active accounts have a row to count attempts against —
			// an unknown email still gets the generic message with no count.
			if (row && row.is_active) {
				const attempts = row.failed_login_attempts + 1;
				if (attempts >= MAX_FAILED_ATTEMPTS) {
					const lockedUntil = new Date(Date.now() + LOCKOUT_MS);
					await sql`
						UPDATE users
						SET failed_login_attempts = 0, locked_until = ${lockedUntil}
						WHERE id = ${row.id}
					`;
					if (row.sfdc_contact_id) {
						await updateSalesforceContact(
							row.sfdc_contact_id,
							{
								Failed_Login_Attempts__c: attempts,
								Account_Locked_Until__c: lockedUntil.toISOString()
							},
							{ userId: row.id }
						);
					}
					return fail(423, { error: formatLockedMessage(lockedUntil), email });
				}

				await sql`
					UPDATE users SET failed_login_attempts = ${attempts} WHERE id = ${row.id}
				`;
				const remaining = MAX_FAILED_ATTEMPTS - attempts;
				return fail(401, {
					error: `${GENERIC_AUTH_ERROR} ${remaining} attempt${remaining === 1 ? '' : 's'} remaining before your account is locked for 24 hours.`,
					email
				});
			}
			return fail(401, { error: GENERIC_AUTH_ERROR, email });
		}

		// ─── 4. Bump last_login_at, clear any failed-attempt count ─────
		try {
			await sql`
				UPDATE users
				SET last_login_at = now(), failed_login_attempts = 0, locked_until = NULL
				WHERE id = ${row.id}
			`;
			if (row.sfdc_contact_id) {
				await updateSalesforceContact(
					row.sfdc_contact_id,
					{ Failed_Login_Attempts__c: 0, Account_Locked_Until__c: null },
					{ userId: row.id }
				);
			}
		} catch (e) {
			// Non-fatal — log and continue.
			const desc = describeError(e);
			await logError({
				source: 'login',
				operation: 'update_last_login',
				severity: 'warn',
				userId: row.id,
				errorMessage: desc.errorMessage,
				stack: desc.stack
			});
		}

		// ─── 4b. Forced reset ──────────────────────────────────────────
		// Provisioned/reset via the Salesforce API: no session yet — issue a
		// reset token and send them straight to the reset-password flow.
		if (row.must_reset_password) {
			const rawToken = randomBytes(32).toString('base64url');
			try {
				const tokenHash = createHash('sha256').update(rawToken).digest('hex');
				await sql`
					INSERT INTO password_reset_tokens (user_id, email, token_hash, expires_at)
					VALUES (${row.id}, ${row.email}, ${tokenHash}, ${new Date(Date.now() + FORCED_RESET_TTL_MS)})
				`;
			} catch (e) {
				const desc = describeError(e);
				await logError({
					source: 'login',
					operation: 'issue_forced_reset_token',
					userId: row.id,
					errorMessage: desc.errorMessage,
					stack: desc.stack
				});
				return fail(500, { error: 'Could not sign you in right now. Please try again.', email });
			}
			throw redirect(303, `/reset-password?token=${rawToken}&forced=1`);
		}

		// ─── 5. Session ───────────────────────────────────────────────
		try {
			const ipAddress = getClientAddress();
			const userAgent = request.headers.get('user-agent') ?? undefined;
			const { rawToken } = await createSession(row.id, { ipAddress, userAgent });

			setSessionCookie(cookies, { url }, rawToken, SESSION_COOKIE_MAX_AGE);
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'login',
				operation: 'create_session',
				userId: row.id,
				errorMessage: desc.errorMessage,
				stack: desc.stack
			});
			return fail(500, { error: 'Could not sign you in right now. Please try again.', email });
		}

		// Respect ?next from either the URL query OR a hidden form field. We
		// look at the form first because that's where it lives after the post.
		const nextFromForm = String(data.get('next') ?? '');
		const nextFromUrl = url.searchParams.get('next');
		throw redirect(303, resolvePostAuthPath(nextFromForm || nextFromUrl));
	}
};
