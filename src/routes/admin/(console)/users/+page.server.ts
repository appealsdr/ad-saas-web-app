import type { PageServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';
import { listAllUsers } from '$lib/server/admin/accounts';
import { parsePage, parsePageSize } from '$lib/server/admin/pagination';

export const load: PageServerLoad = async (event) => {
	requireStaff(event, 'users.read');
	const sp = event.url.searchParams;
	const filter: '' | 'no_account' | 'inactive' | 'locked' = (['no_account', 'inactive', 'locked'] as const).find((f) => f === sp.get('filter')) ?? '';
	const params = { q: (sp.get('q') ?? '').trim().slice(0, 200), page: parsePage(sp.get('page')), pageSize: parsePageSize(sp.get('pageSize')), filter };
	const { rows, total } = await listAllUsers(params);
	return { rows, total, ...params };
};
