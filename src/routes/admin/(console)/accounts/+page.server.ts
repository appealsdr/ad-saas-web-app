import type { PageServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';
import { listAccounts, parseAccountListQuery } from '$lib/server/admin/accounts';

export const load: PageServerLoad = async (event) => {
	requireStaff(event, 'accounts.read');
	const query = parseAccountListQuery(event.url.searchParams);
	const result = await listAccounts(query);
	const qs = new URLSearchParams(event.url.searchParams);
	qs.delete('page');
	return {
		...result,
		query,
		// Serialised list context so "Back to accounts" restores search/sort/page.
		context: event.url.searchParams.toString(),
		baseQuery: qs.toString()
	};
};
