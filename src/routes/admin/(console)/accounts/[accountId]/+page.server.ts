import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { resyncAction } from '$lib/server/admin/resync_action';
import { accountSummary } from '$lib/server/admin/accounts';
import { roleHas } from '$lib/server/admin/permissions';
import { auditActor, clientIp } from '$lib/server/admin/guard';
import { ActionError, deleteAccountCascade, EDITABLE_ACCOUNT_FIELDS, FIELD_OWNERSHIP, SF_FIELD, updateAccountFields, type EditableAccountField } from '$lib/server/admin/actions';

export const load: PageServerLoad = async (event) => {
	const { account, accountId, staff } = await workspace(event, 'accounts.read');
	return {
		freshMfa: staff.freshMfa,
		account,
		summary: await accountSummary(accountId),
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
	delete: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.delete', { freshMfa: true });
		const data = await event.request.formData();
		try {
			await deleteAccountCascade(
				{ actor: auditActor(staff), ip: clientIp(event) },
				accountId,
				String(data.get('reason') ?? ''),
				String(data.get('confirm') ?? '')
			);
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { ok: false as const, error: e.message, deleteError: true as const });
			throw e;
		}
		throw redirect(303, '/admin/accounts?deleted=1');
	}
};
