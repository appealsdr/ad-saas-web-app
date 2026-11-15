import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireStaff, auditActor, clientIp } from '$lib/server/admin/guard';
import { roleHas } from '$lib/server/admin/permissions';
import { ActionError } from '$lib/server/admin/actions';
import { listProvisionCandidates, provisionFromSalesforce } from '$lib/server/admin/provision';
import { describeError } from '$lib/server/error_log';

export const load: PageServerLoad = async (event) => {
	const staff = requireStaff(event, 'accounts.read');
	const q = event.url.searchParams.get('q')?.slice(0, 100) ?? '';
	const canProvision = roleHas(staff.role, 'accounts.update');
	try {
		const list = await listProvisionCandidates(q);
		return { q, canProvision, sfError: null as string | null, ...list };
	} catch (e) {
		// Salesforce unreachable: say so instead of showing an empty list that reads as "nothing to provision".
		return { q, canProvision, sfError: describeError(e).errorMessage, candidates: [], alreadyLinked: 0, truncated: false };
	}
};

export const actions: Actions = {
	provision: async (event) => {
		const staff = requireStaff(event, 'accounts.update', { freshMfa: true });
		const d = await event.request.formData();
		const sfdcAccountId = String(d.get('sfdcAccountId') ?? '');
		try {
			const result = await provisionFromSalesforce(
				{ actor: auditActor(staff), ip: clientIp(event) },
				{
					sfdcAccountId,
					sfdcContactId: String(d.get('sfdcContactId') ?? '') || null,
					storeIds: d.getAll('storeId').map(String),
					createLogin: d.get('createLogin') === 'on',
					reason: String(d.get('reason') ?? '')
				}
			);
			return { ok: { sfdcAccountId, ...result } };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message, sfdcAccountId });
			throw e;
		}
	}
};
