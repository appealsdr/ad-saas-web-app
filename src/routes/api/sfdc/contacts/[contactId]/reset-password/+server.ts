/**
 * POST /api/sfdc/contacts/[contactId]/reset-password — called from
 * Salesforce to force a password reset on the local user linked to a
 * Contact (by sfdc_contact_id). Issues a new one-time temporary password,
 * invalidates any existing sessions, and requires the next login to go
 * through the forced password-change flow.
 *
 * Auth: Bearer API key with the "reset_password" scope.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { requireApiKey } from '$lib/server/auth/api_key';
import { hashPassword } from '$lib/server/auth/password';
import { recordPasswordHistory } from '$lib/server/auth/password_history';
import { generateTempPassword } from '$lib/server/auth/temp_password';
import { logError, describeError } from '$lib/server/error_log';

export const POST: RequestHandler = async ({ request, params }) => {
	const key = await requireApiKey(request, 'reset_password');

	const contactId = params.contactId;
	if (!contactId) throw error(400, 'Missing contactId.');

	const rows = await sql<{ id: string; email: string; is_active: boolean; password_hash: string | null }[]>`
		SELECT id, email, is_active, password_hash FROM users WHERE sfdc_contact_id = ${contactId} LIMIT 1
	`;
	const row = rows[0];
	if (!row) throw error(404, 'No user is linked to this Salesforce Contact.');
	if (!row.is_active) throw error(409, 'This user is deactivated.');

	const tempPassword = generateTempPassword();
	const passwordHash = await hashPassword(tempPassword);

	try {
		await sql.begin(async (tx) => {
			await tx`
				UPDATE users
				SET password_hash = ${passwordHash}, must_reset_password = true
				WHERE id = ${row.id}
			`;
			await tx`DELETE FROM sessions WHERE user_id = ${row.id}`;
		});
		if (row.password_hash) {
			await recordPasswordHistory(row.id, row.password_hash);
		}
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'sfdc.reset_password',
			operation: 'update_password',
			userId: row.id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { sfdcContactId: contactId, apiKeyId: key.id }
		});
		throw error(500, 'Could not reset the password. Please try again.');
	}

	return json({
		userId: row.id,
		username: row.email,
		temporaryPassword: tempPassword
	});
};
