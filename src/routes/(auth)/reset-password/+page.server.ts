/**
 * Forgot-password flow — step 2: consume the token and set a new password.
 *
 * Load:
 *  - Reads ?token from the URL, hashes it, looks up the record.
 *  - Rejects if not found, already used, or expired.
 *  - Passes a minimal { valid: true } to the page so it can show the form.
 *
 * Action:
 *  - Re-validates the token (race-proof).
 *  - Hashes the new password with scrypt.
 *  - Updates users.password_hash and marks the token as used in a transaction.
 */
import { fail, redirect } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth/password';
import { isPasswordReused, recordPasswordHistory } from '$lib/server/auth/password_history';
import { logError, describeError } from '$lib/server/error_log';
import { updateSalesforceContact } from '$lib/server/salesforce/records';
import { sendPasswordChangedEmail } from '$lib/server/salesforce/email';

function hashToken(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

interface TokenRow {
	id: string;
	user_id: string;
	email: string;
	used_at: string | null;
	expires_at: string;
}

async function lookupToken(rawToken: string): Promise<TokenRow | undefined> {
	const tokenHash = hashToken(rawToken);
	const rows = await sql<TokenRow[]>`
		SELECT id, user_id, email, used_at, expires_at
		FROM password_reset_tokens
		WHERE token_hash = ${tokenHash}
		  AND used_at IS NULL
		  AND expires_at > now()
		LIMIT 1
	`;
	return rows[0];
}

export const load: PageServerLoad = async ({ url }) => {
	const rawToken = url.searchParams.get('token') ?? '';
	const forced = url.searchParams.get('forced') === '1';

	if (!rawToken) {
		return { valid: false, token: '', error: 'No reset token provided.', forced };
	}

	let row: TokenRow | undefined;
	try {
		row = await lookupToken(rawToken);
	} catch {
		return { valid: false, token: '', error: 'Could not validate the reset link. Please try again.', forced };
	}

	if (!row) {
		return {
			valid: false,
			token: '',
			error: 'This reset link is invalid or has expired. Please request a new one.',
			forced
		};
	}

	return { valid: true, token: rawToken, error: '', forced };
};

export const actions: Actions = {
	default: async ({ request }) => {
		const data = await request.formData();
		const rawToken = String(data.get('token') ?? '');
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');

		if (!rawToken) {
			return fail(400, { error: 'Missing reset token.', token: '' });
		}
		if (!password || password.length < 8) {
			return fail(400, { error: 'Password must be at least 8 characters.', token: rawToken });
		}
		if (password !== confirm) {
			return fail(400, { error: 'Passwords do not match.', token: rawToken });
		}

		// Re-validate token (prevents TOCTOU race)
		let row: TokenRow | undefined;
		try {
			row = await lookupToken(rawToken);
		} catch (e) {
			const desc = describeError(e);
			await logError({ source: 'reset-password', operation: 'lookup_token', errorMessage: desc.errorMessage, stack: desc.stack });
			return fail(500, { error: 'Something went wrong. Please try again.', token: rawToken });
		}

		if (!row) {
			return fail(400, {
				error: 'This reset link is invalid or has expired. Please request a new one.',
				token: rawToken
			});
		}

		try {
			if (await isPasswordReused(row.user_id, password)) {
				return fail(400, {
					error: 'Please choose a password you have not used recently.',
					token: rawToken
				});
			}
		} catch (e) {
			const desc = describeError(e);
			await logError({ source: 'reset-password', operation: 'check_password_reuse', userId: row.user_id, errorMessage: desc.errorMessage, stack: desc.stack });
			return fail(500, { error: 'Something went wrong. Please try again.', token: rawToken });
		}

		let passwordHash: string;
		try {
			passwordHash = await hashPassword(password);
		} catch (e) {
			const desc = describeError(e);
			await logError({ source: 'reset-password', operation: 'hash_password', userId: row.user_id, errorMessage: desc.errorMessage, stack: desc.stack });
			return fail(500, { error: 'Something went wrong. Please try again.', token: rawToken });
		}

		const tokenHash = hashToken(rawToken);
		try {
			const [before] = await sql<{ password_hash: string | null; sfdc_contact_id: string | null; email: string }[]>`
				SELECT password_hash, sfdc_contact_id, email FROM users WHERE id = ${row.user_id} LIMIT 1
			`;
			await sql.begin(async (tx) => {
				await tx`
					UPDATE users
					SET password_hash = ${passwordHash}, must_reset_password = false
					WHERE id = ${row!.user_id}
				`;
				await tx`
					UPDATE password_reset_tokens
					SET used_at = now()
					WHERE token_hash = ${tokenHash}
				`;
				// A password reset invalidates every live session for this user —
				// customer sessions AND platform-admin sessions (staff must re-auth + MFA).
				await tx`DELETE FROM sessions WHERE user_id = ${row!.user_id}`;
				await tx`
					UPDATE admin_sessions
					SET revoked_at = now(), revoked_reason = 'password_reset'
					WHERE user_id = ${row!.user_id} AND revoked_at IS NULL
				`;
			});
			if (before?.password_hash) {
				await recordPasswordHistory(row.user_id, before.password_hash);
			}
			if (before?.sfdc_contact_id) {
				// Best-effort — never blocks the reset on a Salesforce hiccup.
				// We record that a reset happened, not the password values themselves.
				await updateSalesforceContact(
					before.sfdc_contact_id,
					{
						Temp_Password_For_App__c: null,
						Password_Reset_At__c: new Date().toISOString()
					},
					{ userId: row.user_id }
				);
			}
			// Security notification (best-effort; the reset itself already succeeded).
			if (before?.email) {
				await sendPasswordChangedEmail(before.email, 'completed', { sfdcContactId: before.sfdc_contact_id, userId: row.user_id });
			}
		} catch (e) {
			const desc = describeError(e);
			await logError({ source: 'reset-password', operation: 'update_password', userId: row.user_id, errorMessage: desc.errorMessage, stack: desc.stack });
			return fail(500, { error: 'Could not update your password. Please try again.', token: rawToken });
		}

		throw redirect(303, '/login?reset=1');
	}
};
