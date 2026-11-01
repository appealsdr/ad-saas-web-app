/**
 * Forgot-password flow — step 1: request a reset link.
 *
 * Always shows a success message regardless of whether the email exists in the
 * DB, so an attacker cannot enumerate accounts via this endpoint.
 *
 * Flow:
 *  1. Validate email shape.
 *  2. Look up user.
 *  3. If found: generate a cryptographically-random token, store a SHA-256 hash
 *     of it in password_reset_tokens, send the raw token via Salesforce email.
 *  4. Return success (same message regardless of lookup result).
 */
import { fail } from '@sveltejs/kit';
import { randomBytes, createHash } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { sendPasswordResetEmail } from '$lib/server/salesforce/email';
import { logError, describeError } from '$lib/server/error_log';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_BYTES = 32;       // 256 bits of entropy
const TTL_SECONDS = 60 * 60; // 1 hour

function generateToken(): string {
	return randomBytes(TOKEN_BYTES).toString('hex');
}

function hashToken(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

export const load: PageServerLoad = async ({ locals }) => {
	// Already signed in → they don't need this page
	if (locals.user) {
		const { redirect } = await import('@sveltejs/kit');
		throw redirect(303, '/dashboard');
	}
	return {};
};

export const actions: Actions = {
	default: async ({ request, url }) => {
		const data = await request.formData();
		const email = String(data.get('email') ?? '').trim().toLowerCase();

		if (!email || !EMAIL_RE.test(email)) {
			return fail(400, { error: 'Please enter a valid email address.', email });
		}

		// Look up user — we need the id (+ SF contact link) but must not leak existence.
		let userId: string | undefined;
		let sfdcContactId: string | null = null;
		try {
			const rows = await sql<{ id: string; sfdc_contact_id: string | null }[]>`
				SELECT id, sfdc_contact_id FROM users
				WHERE email = ${email} AND is_active = true
				LIMIT 1
			`;
			userId = rows[0]?.id;
			sfdcContactId = rows[0]?.sfdc_contact_id ?? null;
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'forgot-password',
				operation: 'lookup_user',
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { email }
			});
			return fail(500, { error: 'Something went wrong. Please try again.', email });
		}

		if (userId) {
			const rawToken = generateToken();
			const tokenHash = hashToken(rawToken);
			const resetUrl = `${url.origin}/reset-password?token=${rawToken}`;

			try {
				await sql`
					INSERT INTO password_reset_tokens (user_id, email, token_hash, expires_at)
					VALUES (
						${userId},
						${email},
						${tokenHash},
						now() + (${TTL_SECONDS} * interval '1 second')
					)
				`;
			} catch (e) {
				const desc = describeError(e);
				await logError({
					source: 'forgot-password',
					operation: 'insert_token',
					userId,
					errorMessage: desc.errorMessage,
					stack: desc.stack
				});
				return fail(500, { error: 'Something went wrong. Please try again.', email });
			}

			try {
				// sendPasswordResetEmail logs its own failure (and, on success,
				// logs an EmailMessage against the Salesforce Contact when known).
				await sendPasswordResetEmail(email, resetUrl, { sfdcContactId, userId });
			} catch {
				// Email failed — clean up the token so it can't be used
				await sql`DELETE FROM password_reset_tokens WHERE token_hash = ${tokenHash}`.catch(() => {});
				return fail(500, { error: 'Could not send the reset email. Please try again.', email });
			}
		}

		// Always return success — don't reveal whether the email exists.
		return { success: true };
	}
};
