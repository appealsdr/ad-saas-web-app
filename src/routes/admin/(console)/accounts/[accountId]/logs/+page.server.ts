import type { PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { parseLogFilters, queryLogs } from '$lib/server/admin/logs';
import { requireStaff } from '$lib/server/admin/guard';

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'accounts.read');
	requireStaff(event, 'logs.read');
	// Account is pinned from the route — the `account` query param is ignored here.
	const result = await queryLogs(parseLogFilters(event.url.searchParams, accountId));
	const filters = Object.fromEntries(
		[...event.url.searchParams.entries()].filter(([k, v]) => !['cursor', 'account'].includes(k) && v !== '')
	);
	return { ...result, filters };
};
