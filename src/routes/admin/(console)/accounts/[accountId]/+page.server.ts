import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { resyncAction } from '$lib/server/admin/resync_action';
import { accountSummary, getMessagesEnabled, getMcpEnabled } from '$lib/server/admin/accounts';
import { roleHas } from '$lib/server/admin/permissions';
import { sql } from '$lib/server/db';
import { recordAudit } from '$lib/server/admin/audit';
import { revokeAllGrants } from '$lib/server/oauth/core';
import { raiseAlert } from '$lib/server/security/alerts';
import { auditActor, clientIp } from '$lib/server/admin/guard';
import { ActionError, deleteAccountCascade, EDITABLE_ACCOUNT_FIELDS, FIELD_OWNERSHIP, SF_FIELD, updateAccountFields, type EditableAccountField } from '$lib/server/admin/actions';

export const load: PageServerLoad = async (event) => {
	const { account, accountId, staff } = await workspace(event, 'accounts.read');
	return {
		freshMfa: staff.freshMfa,
		account,
		summary: await accountSummary(accountId),
		messagesEnabled: await getMessagesEnabled(accountId),
		mcpEnabled: await getMcpEnabled(accountId),
		canEdit: roleHas(staff.role, 'accounts.update'),
		canDelete: roleHas(staff.role, 'accounts.delete'),
		ownership: FIELD_OWNERSHIP,
		sfFields: SF_FIELD as Record<string, string>
	};
};

export const actions: Actions = {
	resync: resyncAction,
	update: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update');
		const data = await event.request.formData();
		const input: Partial<Record<EditableAccountField, string>> = {};
		for (const f of EDITABLE_ACCOUNT_FIELDS) if (data.has(f)) input[f] = String(data.get(f) ?? '');
		try {
			const r = await updateAccountFields(
				{ actor: auditActor(staff), ip: clientIp(event) },
				accountId,
				String(data.get('version') ?? ''),
				input
			);
			return { ok: true as const, result: r };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { ok: false as const, error: e.message });
			throw e;
		}
	},
	/** AD-1968: enable/disable the global Messages tab for this account. */
	set_messages: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update');
		const data = await event.request.formData();
		const enabled = data.get('enabled') === 'on';
		try {
			await sql.begin(async (tx) => {
				await tx`UPDATE accounts SET messages_enabled = ${enabled} WHERE id = ${accountId}`;
				await recordAudit(
					{ actor: auditActor(staff), action: 'account.messages_toggle', targetType: 'account', targetId: accountId, targetAccountId: accountId, outcome: 'success', ip: clientIp(event), metadata: { messages_enabled: enabled } },
					tx
				);
			});
		} catch {
			return fail(500, { ok: false as const, error: 'Could not update the Messages setting. Has migration 041 been applied?' });
		}
		return { ok: `Messages tab ${enabled ? 'enabled' : 'disabled'} for this account.` };
	},
	/** AD-1969: per-account switch for the AI connector. Turning it OFF also disconnects every assistant of the account. */
	set_mcp: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update');
		const enabled = (await event.request.formData()).get('enabled') === 'on';
		try {
			await sql.begin(async (tx) => {
				await tx`UPDATE accounts SET mcp_enabled = ${enabled} WHERE id = ${accountId}`;
				await recordAudit({ actor: auditActor(staff), action: 'account.mcp_toggle', targetType: 'account', targetId: accountId, targetAccountId: accountId, outcome: 'success', ip: clientIp(event), metadata: { mcp_enabled: enabled } }, tx);
			});
			let revoked = 0;
			if (!enabled) {
				revoked = await revokeAllGrants({ accountId }, 'AI connector disabled by platform admin');
				if (revoked) await raiseAlert({ kind: 'connections_revoked', severity: 'info', accountId, subjectType: 'account', subjectId: accountId, message: `AI connector disabled for the account; ${revoked} connection(s) revoked by ${staff.email}.`, dedupeSeconds: 1 });
			}
			return { ok: `AI connector ${enabled ? 'enabled' : `disabled${revoked ? ` and ${revoked} connection(s) revoked` : ''}`} for this account.` };
		} catch {
			return fail(500, { ok: false as const, error: 'Could not update the AI connector setting. Has migration 042 been applied?' });
		}
	},
	revoke_connections: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update');
		const n = await revokeAllGrants({ accountId }, 'revoked by platform admin');
		await recordAudit({ actor: auditActor(staff), action: 'account.mcp_revoke_all', targetType: 'account', targetId: accountId, targetAccountId: accountId, outcome: 'success', ip: clientIp(event), metadata: { revoked: n } });
		return { ok: `${n} AI connection(s) revoked.` };
	},
	delete: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.delete', { freshMfa: true });
		const data = await event.request.formData();
		let result;
		try {
			result = await deleteAccountCascade(
				{ actor: auditActor(staff), ip: clientIp(event) },
				accountId,
				String(data.get('reason') ?? ''),
				String(data.get('confirm') ?? '')
			);
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { ok: false as const, error: e.message, deleteError: true as const });
			throw e;
		}
		throw redirect(303, `/admin/accounts?deleted=1&sf=${result.salesforce.cleared}&sffail=${result.salesforce.failed.length}`);
	}
};
