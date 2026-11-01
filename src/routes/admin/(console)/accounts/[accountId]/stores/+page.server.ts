import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { listAccountStores } from '$lib/server/admin/accounts';
import { roleHas } from '$lib/server/admin/permissions';
import { sfExisting, sfState } from '$lib/server/admin/sf_sync';
import { resyncAction } from '$lib/server/admin/resync_action';
import { auditActor, clientIp, isUuid } from '$lib/server/admin/guard';
import { ActionError } from '$lib/server/admin/actions';
import { deleteRecord } from '$lib/server/admin/records';
import { salesforceUrl } from '$lib/server/admin/links';

export const load: PageServerLoad = async (event) => {
	const { accountId, staff } = await workspace(event, 'accounts.read');
	const stores = await listAccountStores(accountId);
	const existing = await sfExisting('Store__c', stores.map((s) => s.sfdc_store_id));
	return {
		stores: await Promise.all(stores.map(async (s) => ({ ...s, sfState: sfState(s.sfdc_store_id, existing), sfUrl: await salesforceUrl('Store__c', s.sfdc_store_id) }))),
		canEdit: roleHas(staff.role, 'accounts.update'),
		canSync: roleHas(staff.role, 'accounts.update'),
		canDelete: roleHas(staff.role, 'accounts.delete')
	};
};

export const actions: Actions = {
	resync: resyncAction,
	delete: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.delete', { freshMfa: true });
		const d = await event.request.formData();
		const storeId = String(d.get('targetId') ?? '');
		if (!isUuid(storeId)) return fail(400, { error: 'Invalid request.' });
		try {
			return { ok: await deleteRecord({ actor: auditActor(staff), ip: clientIp(event) }, accountId, 'store', storeId, String(d.get('reason') ?? ''), String(d.get('confirm') ?? '')) };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message });
			throw e;
		}
	}
};
