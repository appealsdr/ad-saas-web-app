/**
 * Validated customer-management actions performed by platform staff.
 *
 * Every function:
 *   - takes an explicit target account AND re-checks child ownership
 *   - requires a reason for security actions
 *   - commits the local mutation and its success audit event in ONE transaction
 *     (a failed audit insert rolls the mutation back)
 *   - for external effects (Salesforce, email) records intent first, then a
 *     durable success/failure event carrying the same correlation id
 *
 * Field ownership for account edits (documented, enforced by FIELD_OWNERSHIP):
 *   billing_*   shared: local DB is updated, then pushed to the Salesforce
 *               Account (BillingStreet/City/State/PostalCode/Country) via the
 *               existing updateSalesforceAccount service. Sync result is reported.
 *   name, email, phone, website  shared the same way (Account.Name / Primary_Email__c / Phone / Website).
 */
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { sql } from '../db';
import { recordAudit, type AuditActor } from './audit';
import { getAccount, getAccountUser } from './accounts';
import { setRequestAccount } from './request_context';
import { updateSalesforceAccount } from '../salesforce/records';
import { sendPasswordChangedEmail, sendPasswordResetEmail } from '../salesforce/email';
import { logError } from '../error_log';
import { hashPassword } from '../auth/password';
import { generateTempPassword } from '../auth/temp_password';
import { deleteObject } from '../storage/s3';

export class ActionError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 409 | 422 | 502 = 400
	) {
		super(message);
	}
}

export const FIELD_OWNERSHIP = {
	name: 'salesforce-synced',
	email: 'salesforce-synced',
	phone: 'salesforce-synced',
	website: 'salesforce-synced',
	billing_street: 'salesforce-synced',
	billing_city: 'salesforce-synced',
	billing_state: 'salesforce-synced',
	billing_postal_code: 'salesforce-synced',
	billing_country: 'salesforce-synced'
} as const;
export type EditableAccountField = keyof typeof FIELD_OWNERSHIP;
export const EDITABLE_ACCOUNT_FIELDS = Object.keys(FIELD_OWNERSHIP) as EditableAccountField[];

export const SF_FIELD: Partial<Record<EditableAccountField, string>> = {
	name: 'Name',
	email: 'Primary_Email__c',
	phone: 'Phone',
	website: 'Website',
	billing_street: 'BillingStreet',
	billing_city: 'BillingCity',
	billing_state: 'BillingState',
	billing_postal_code: 'BillingPostalCode',
	billing_country: 'BillingCountry'
};

export function requireReason(reason: string | null | undefined): string {
	const r = (reason ?? '').trim();
	if (r.length < 5) throw new ActionError('A reason (at least 5 characters) is required.', 422);
	if (r.length > 500) throw new ActionError('Reason must be 500 characters or fewer.', 422);
	return r;
}

function requireConfirmation(confirm: string | null | undefined, expected: string): void {
	if ((confirm ?? '').trim().toLowerCase() !== expected.trim().toLowerCase()) {
		throw new ActionError(`Confirmation did not match. Type "${expected}" to confirm.`, 422);
	}
}

interface Ctx {
	actor: AuditActor;
	ip?: string | null;
}

// ─── Account edit ─────────────────────────────────────────────────────────

export interface AccountEditResult {
	version: string;
	changed: EditableAccountField[];
	salesforce: 'not_applicable' | 'not_linked' | 'synced' | 'failed';
	salesforceError?: string;
}

export async function updateAccountFields(
	ctx: Ctx,
	accountId: string,
	expectedVersion: string,
	input: Partial<Record<EditableAccountField, string | null>>
): Promise<AccountEditResult> {
	setRequestAccount(accountId);
	const current = await getAccount(accountId);
	if (!current) throw new ActionError('Account not found.', 404);

	const next: Partial<Record<EditableAccountField, string | null>> = {};
	const changed: EditableAccountField[] = [];
	for (const f of EDITABLE_ACCOUNT_FIELDS) {
		if (!(f in input)) continue;
		const v = (input[f] ?? '').toString().trim();
		if (v.length > 300) throw new ActionError(`${f} is too long.`, 422);
		if (f === 'name' && v === '') throw new ActionError('Company name is required.', 422);
		const value = v === '' ? null : v;
		if (value !== (current[f] ?? null)) {
			next[f] = value;
			changed.push(f);
		}
	}
	if (!changed.length) throw new ActionError('No changes to save.', 422);

	const diff = Object.fromEntries(changed.map((f) => [f, { from: current[f] ?? null, to: next[f] ?? null }]));

	const version = await sql.begin(async (tx) => {
		const set = { ...next } as Record<string, string | null>;
		const rows = await tx<{ version: string }[]>`
			UPDATE accounts SET ${tx(set, ...Object.keys(set))}
			WHERE id = ${accountId}
			  AND to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = ${expectedVersion}
			RETURNING to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
		`;
		if (!rows.length) {
			throw new ActionError('This account was changed by someone else since you opened it. Reload and try again.', 409);
		}
		await recordAudit(
			{
				actor: ctx.actor,
				action: 'account.update',
				targetType: 'account',
				targetId: accountId,
				targetAccountId: accountId,
				outcome: 'success',
				ip: ctx.ip,
				metadata: { changes: diff, ownership: Object.fromEntries(changed.map((f) => [f, FIELD_OWNERSHIP[f]])) }
			},
			tx
		);
		return rows[0].version;
	});

	// External push for Salesforce-synced fields. Local change is already durable.
	const sfFields = changed.filter((f) => FIELD_OWNERSHIP[f] === 'salesforce-synced');
	if (!sfFields.length) return { version, changed, salesforce: 'not_applicable' };
	if (!current.sfdc_account_id) {
		return { version, changed, salesforce: 'not_linked' };
	}
	const correlationId = randomUUID();
	await recordAudit(
		{ actor: ctx.actor, action: 'account.salesforce_sync', targetType: 'account', targetId: accountId, targetAccountId: accountId, outcome: 'pending', ip: ctx.ip, metadata: { correlationId, fields: sfFields } },
		sql,
		{ bestEffort: true }
	);
	const patch: Record<string, string | null> = {};
	for (const f of sfFields) patch[SF_FIELD[f]!] = next[f] ?? null;
	const result = await updateSalesforceAccount(current.sfdc_account_id, patch, { accountId });
	await recordAudit(
		{
			actor: ctx.actor,
			action: 'account.salesforce_sync',
			targetType: 'account',
			targetId: accountId,
			targetAccountId: accountId,
			outcome: result.ok ? 'success' : 'failure',
			ip: ctx.ip,
			metadata: { correlationId, fields: sfFields, error: result.ok ? undefined : result.error }
		},
		sql,
		{ bestEffort: true }
	);
	return result.ok
		? { version, changed, salesforce: 'synced' }
		: { version, changed, salesforce: 'failed', salesforceError: result.error };
}

// ─── Customer user management ─────────────────────────────────────────────

async function targetUser(accountId: string, userId: string) {
	setRequestAccount(accountId);
	const u = await getAccountUser(accountId, userId); // ownership check: user must belong to THIS account
	if (!u) throw new ActionError('User not found in this account.', 404);
	if (u.is_staff) throw new ActionError('Platform staff are managed under Staff, not here.', 403);
	return u;
}

export type UserAction = 'suspend' | 'reactivate' | 'unlock' | 'revoke_sessions';

export async function manageCustomerUser(
	ctx: Ctx,
	accountId: string,
	userId: string,
	action: UserAction,
	reason: string | null,
	confirm: string | null
): Promise<{ message: string }> {
	const why = requireReason(reason);
	const user = await targetUser(accountId, userId);
	requireConfirmation(confirm, user.email);

	await sql.begin(async (tx) => {
		let detail: Record<string, unknown> = {};
		if (action === 'suspend') {
			if (!user.is_active) throw new ActionError('User is already suspended.', 409);
			await tx`UPDATE users SET is_active = false WHERE id = ${userId} AND account_id = ${accountId}`;
			const del = await tx`DELETE FROM sessions WHERE user_id = ${userId} RETURNING id`;
			detail = { sessionsRevoked: del.length };
		} else if (action === 'reactivate') {
			if (user.is_active) throw new ActionError('User is already active.', 409);
			await tx`UPDATE users SET is_active = true WHERE id = ${userId} AND account_id = ${accountId}`;
		} else if (action === 'unlock') {
			await tx`
				UPDATE users SET locked_until = NULL, failed_login_attempts = 0
				WHERE id = ${userId} AND account_id = ${accountId}
			`;
		} else if (action === 'revoke_sessions') {
			const del = await tx`DELETE FROM sessions WHERE user_id = ${userId} RETURNING id`;
			detail = { sessionsRevoked: del.length };
		} else {
			throw new ActionError('Unknown action.', 400);
		}
		await recordAudit(
			{
				actor: ctx.actor,
				action: `user.${action}`,
				targetType: 'user',
				targetId: userId,
				targetAccountId: accountId,
				outcome: 'success',
				reason: why,
				ip: ctx.ip,
				metadata: { targetEmail: user.email, ...detail }
			},
			tx
		);
	});
	const messages: Record<UserAction, string> = {
		suspend: `${user.email} suspended and signed out.`,
		reactivate: `${user.email} reactivated.`,
		unlock: `${user.email} unlocked.`,
		revoke_sessions: `All customer sessions for ${user.email} revoked.`
	};
	return { message: messages[action] };
}

/**
 * Initiate the EXISTING password-reset email flow for a customer. The reset
 * token/link is never returned to the administrator. If delivery fails the
 * token is deleted and the failure is reported honestly.
 */
export async function initiatePasswordReset(
	ctx: Ctx & { origin: string },
	accountId: string,
	userId: string,
	reason: string | null,
	confirm: string | null
): Promise<{ message: string }> {
	const why = requireReason(reason);
	const user = await targetUser(accountId, userId);
	requireConfirmation(confirm, user.email);
	if (!user.is_active) throw new ActionError('User is suspended; reactivate before sending a reset.', 409);

	const [full] = await sql<{ sfdc_contact_id: string | null }[]>`SELECT sfdc_contact_id FROM users WHERE id = ${userId}`;
	const correlationId = randomUUID();
	const rawToken = randomBytes(32).toString('hex');
	const tokenHash = createHash('sha256').update(rawToken).digest('hex');

	await sql.begin(async (tx) => {
		await tx`
			INSERT INTO password_reset_tokens (user_id, email, token_hash, expires_at)
			VALUES (${userId}, ${user.email}, ${tokenHash}, now() + interval '1 hour')
		`;
		await recordAudit(
			{
				actor: ctx.actor,
				action: 'user.password_reset.initiate',
				targetType: 'user',
				targetId: userId,
				targetAccountId: accountId,
				outcome: 'pending',
				reason: why,
				ip: ctx.ip,
				metadata: { correlationId, targetEmail: user.email }
			},
			tx
		);
	});

	try {
		await sendPasswordResetEmail(user.email, `${ctx.origin}/reset-password?token=${rawToken}`, {
			sfdcContactId: full?.sfdc_contact_id ?? null,
			userId,
			accountId
		});
	} catch (e) {
		await sql`DELETE FROM password_reset_tokens WHERE token_hash = ${tokenHash}`.catch(() => {});
		await recordAudit(
			{ actor: ctx.actor, action: 'user.password_reset.initiate', targetType: 'user', targetId: userId, targetAccountId: accountId, outcome: 'failure', reason: why, ip: ctx.ip, metadata: { correlationId, error: e instanceof Error ? e.message : 'delivery failed' } },
			sql,
			{ bestEffort: true }
		);
		await logError({ source: 'admin.password_reset', operation: 'send_email', accountId, userId, errorMessage: e instanceof Error ? e.message : String(e) });
		throw new ActionError('The reset email could not be delivered. No reset link was issued.', 502);
	}
	await recordAudit(
		{ actor: ctx.actor, action: 'user.password_reset.initiate', targetType: 'user', targetId: userId, targetAccountId: accountId, outcome: 'success', reason: why, ip: ctx.ip, metadata: { correlationId, delivered: true } },
		sql,
		{ bestEffort: true }
	);
	return { message: `Password reset email sent to ${user.email}.` };
}

/**
 * Set a one-time temporary password for a customer user (for when email delivery
 * is unavailable). The password is returned ONCE to the administrator, is never
 * written to the audit log, forces the user to choose a new password at next
 * sign-in, clears any lockout and revokes all of the user's sessions.
 */
export async function setTemporaryPassword(
	ctx: Ctx,
	accountId: string,
	userId: string,
	reason: string | null,
	confirm: string | null
): Promise<{ message: string; tempPassword: string }> {
	const why = requireReason(reason);
	const user = await targetUser(accountId, userId);
	requireConfirmation(confirm, user.email);
	if (!user.is_active) throw new ActionError('User is suspended; reactivate before setting a password.', 409);

	const tempPassword = generateTempPassword();
	const passwordHash = await hashPassword(tempPassword);
	await sql.begin(async (tx) => {
		await tx`
			UPDATE users
			SET password_hash = ${passwordHash}, must_reset_password = true,
			    failed_login_attempts = 0, locked_until = NULL
			WHERE id = ${userId} AND account_id = ${accountId}
		`;
		const del = await tx`DELETE FROM sessions WHERE user_id = ${userId} RETURNING id`;
		await tx`DELETE FROM password_reset_tokens WHERE user_id = ${userId}`;
		await recordAudit(
			{
				actor: ctx.actor,
				action: 'user.password_reset.temporary',
				targetType: 'user',
				targetId: userId,
				targetAccountId: accountId,
				outcome: 'success',
				reason: why,
				ip: ctx.ip,
				metadata: { targetEmail: user.email, sessionsRevoked: del.length }
			},
			tx
		);
	});
	// Tell the user their password was reset (never includes the password). Best-effort.
	const [full] = await sql<{ sfdc_contact_id: string | null }[]>`SELECT sfdc_contact_id FROM users WHERE id = ${userId}`;
	const notified = await sendPasswordChangedEmail(user.email, 'admin', { sfdcContactId: full?.sfdc_contact_id ?? null, userId, accountId });
	await recordAudit(
		{ actor: ctx.actor, action: 'user.password_reset.notification', targetType: 'user', targetId: userId, targetAccountId: accountId, outcome: notified ? 'success' : 'failure', ip: ctx.ip, metadata: { kind: 'admin_temporary' } },
		sql,
		{ bestEffort: true }
	);
	return {
		message: `Temporary password set for ${user.email}. They must choose a new password at next sign-in. ${notified ? 'A notification email was sent to them.' : 'The notification email could NOT be sent — tell them directly.'}`,
		tempPassword
	};
}

// ─── Account deletion ─────────────────────────────────────────────────────

export interface DeleteAccountResult {
	message: string;
	deleted: Record<string, number>;
	files: { attempted: number };
}

/**
 * Permanently delete an account and EVERYTHING that belongs to it from our
 * database: users (and their sessions/tokens/history/OAuth links), stores,
 * store + case documents, service contracts + line items, chat messages,
 * SP-API OAuth states, contacts, error/activity log rows for the account or its
 * users, and cached Salesforce mirror rows. Stored document files are removed
 * from S3 best-effort after the database commit. Salesforce and Stripe are NOT
 * touched. The admin audit trail is intentionally preserved (append-only).
 * The caller must confirm by typing the account name.
 */
export async function deleteAccountCascade(
	ctx: Ctx,
	accountId: string,
	reason: string | null,
	confirm: string | null
): Promise<DeleteAccountResult> {
	const why = requireReason(reason);
	setRequestAccount(accountId);
	const account = await getAccount(accountId);
	if (!account) throw new ActionError('Account not found.', 404);
	requireConfirmation(confirm, account.name);

	const staff = await sql<{ email: string }[]>`
		SELECT u.email FROM users u JOIN platform_staff ps ON ps.user_id = u.id
		WHERE u.account_id = ${accountId}
	`;
	if (staff.length) {
		throw new ActionError(`This account contains platform staff (${staff.map((s) => s.email).join(', ')}). Remove their staff membership first.`, 409);
	}

	let fileKeys: string[] = [];
	const deleted = await sql.begin(async (tx) => {
		const users = await tx<{ id: string; email: string; sfdc_contact_id: string | null }[]>`
			SELECT id, email, sfdc_contact_id FROM users WHERE account_id = ${accountId}
		`;
		const userIds = users.map((u) => u.id);
		const stores = await tx<{ id: string; sfdc_store_id: string | null }[]>`
			SELECT id, sfdc_store_id FROM stores WHERE account_id = ${accountId}
		`;
		const storeIds = stores.map((s) => s.id);
		const contracts = await tx<{ sfdc_service_contract_id: string | null }[]>`
			SELECT sfdc_service_contract_id FROM service_contracts WHERE account_id = ${accountId}
		`;
		// Uploads live in S3 under s3_key (store_documents also has a legacy storage_path).
		const docs = storeIds.length
			? await tx<{ k: string | null }[]>`
					SELECT s3_key AS k FROM store_documents WHERE store_id IN ${tx(storeIds)}
					UNION ALL
					SELECT s3_key AS k FROM case_documents WHERE store_id IN ${tx(storeIds)}
				`
			: [];
		fileKeys = [...new Set(docs.map((d) => d.k).filter((k): k is string => !!k))];

		const sfIds = [
			account.sfdc_account_id,
			...users.map((u) => u.sfdc_contact_id),
			...stores.map((s) => s.sfdc_store_id),
			...contracts.map((c) => c.sfdc_service_contract_id)
		].filter((v): v is string => !!v);

		const counts: Record<string, number> = { users: users.length, stores: stores.length, files: fileKeys.length };
		// error_log/activity_log only SET NULL on delete — remove them explicitly.
		counts.error_log = (await tx`
			DELETE FROM error_log WHERE account_id = ${accountId}
			${userIds.length ? tx`OR user_id IN ${tx(userIds)}` : tx``} RETURNING id`).length;
		if (userIds.length) {
			counts.activity_log = (await tx`DELETE FROM activity_log WHERE user_id IN ${tx(userIds)} RETURNING 1`).length;
		}
		if (sfIds.length) {
			counts.sfdc_records = (await tx`DELETE FROM sfdc_records WHERE sfdc_id IN ${tx(sfIds)} RETURNING 1`).length;
			await tx`DELETE FROM sfdc_sync_queue WHERE record_id IN ${tx([...sfIds, accountId, ...userIds, ...storeIds])}`;
		}
		// users.account_id is SET NULL, not CASCADE — delete explicitly (this also
		// cascades sessions, reset tokens, password history, OAuth links, ...).
		await tx`DELETE FROM users WHERE account_id = ${accountId}`;
		// accounts cascade: stores → documents/oauth states, service_contracts →
		// line items, account_contacts, ai_chat_messages.
		await tx`DELETE FROM accounts WHERE id = ${accountId}`;

		await recordAudit(
			{
				actor: ctx.actor,
				action: 'account.delete',
				targetType: 'account',
				targetId: accountId,
				targetAccountId: accountId,
				outcome: 'success',
				reason: why,
				ip: ctx.ip,
				metadata: { accountName: account.name, sfdcAccountId: account.sfdc_account_id, userEmails: users.map((u) => u.email), counts }
			},
			tx
		);
		return counts;
	});

	// Files last: the database is already consistent, so a failure here only
	// leaves orphaned objects (deleteObject is best-effort).
	await Promise.all(fileKeys.map((k) => deleteObject(k)));
	return {
		message: `Account “${account.name}” and all related records were permanently deleted.`,
		deleted,
		files: { attempted: fileKeys.length }
	};
}
