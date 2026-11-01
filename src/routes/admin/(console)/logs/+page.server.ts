import type { PageServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';
import { parseLogFilters, queryLogs } from '$lib/server/admin/logs';

export const load: PageServerLoad = async (event) => {
	requireStaff(event, 'logs.read');
	const f = parseLogFilters(event.url.searchParams);
	const result = await queryLogs(f);
	const filters = Object.fromEntries(
		[...event.url.searchParams.entries()].filter(([k, v]) => k !== 'cursor' && v !== '')
	);
	return { ...result, filters };
};
