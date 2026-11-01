import type { PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { requireStaff } from '$lib/server/admin/guard';
import { appActivity, parseActivityQuery, RANGES, TYPES } from '$lib/server/admin/app_activity';

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'accounts.read');
	requireStaff(event, 'logs.read');
	const q = parseActivityQuery(accountId, event.url.searchParams);
	const data = await appActivity(q);
	return { ...data, filters: { days: q.days, user: q.userId ?? '', type: q.type ?? '' }, ranges: RANGES, types: TYPES };
};
