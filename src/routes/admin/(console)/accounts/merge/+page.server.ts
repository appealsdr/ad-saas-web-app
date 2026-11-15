import type { PageServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';
import { listDuplicateGroups } from '$lib/server/admin/merge_candidates';

export const load: PageServerLoad = async (event) => {
	requireStaff(event, 'accounts.read');
	const { groups, scanned } = await listDuplicateGroups();
	return {
		scanned,
		groups: groups.map((g) => ({
			signal: g.signal,
			key: g.key,
			accounts: g.accounts.map((a) => ({
				id: a.id, name: a.name, sfdc: a.sfdc_account_id, users: a.user_count, stores: a.store_count,
				contracts: a.contract_count, created: new Date(a.created_at).toISOString().slice(0, 10)
			}))
		}))
	};
};
