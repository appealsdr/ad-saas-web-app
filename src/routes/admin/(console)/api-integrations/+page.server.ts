import type { PageServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';

export const load: PageServerLoad = async (event) => {
	requireStaff(event, 'accounts.read');
	return { origin: event.url.origin };
};
