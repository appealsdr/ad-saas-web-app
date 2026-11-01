import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { roleHas } from '$lib/server/admin/permissions';
import { accountContracts } from '$lib/server/admin/billing';
import { sfExisting, sfState } from '$lib/server/admin/sf_sync';
import { salesforceUrl, stripeUrl } from '$lib/server/admin/links';
import { resyncAction } from '$lib/server/admin/resync_action';
import { auditActor, clientIp, isUuid } from '$lib/server/admin/guard';
import { ActionError } from '$lib/server/admin/actions';
import { deleteRecord } from '$lib/server/admin/records';

export const load: PageServerLoad = async (event) => {
	const { accountId, staff } = await workspace(event, 'accounts.read');
	const { contracts, paymentsError } = await accountContracts(accountId);
	const existing = await sfExisting('ServiceContract', contracts.map((c) => c.sfdcId));
	const rows = await Promise.all(contracts.map(async (c) => ({
		...c,
		sfState: sfState(c.sfdcId, existing),
		sfUrl: await salesforceUrl('ServiceContract', c.sfdcId),
		stripeUrl: stripeUrl('payment', c.stripePi) ?? stripeUrl('subscription', c.stripeSub)
	})));
	return { contracts: rows, paymentsError, canSync: roleHas(staff.role, 'accounts.update'), canDelete: roleHas(staff.role, 'accounts.delete') };
};

export const actions: Actions = {
	resync: resyncAction,
	delete: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.delete', { freshMfa: true });
		const d = await event.request.formData();
		const id = String(d.get('targetId') ?? '');
		if (!isUuid(id)) return fail(400, { error: 'Invalid request.' });
		try {
			return { ok: await deleteRecord({ actor: auditActor(staff), ip: clientIp(event) }, accountId, 'contract', id, String(d.get('reason') ?? ''), String(d.get('confirm') ?? '')) };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message });
			throw e;
		}
	}
};
