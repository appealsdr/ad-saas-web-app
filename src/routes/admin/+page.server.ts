import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';

// No dashboard: account-first landing. Unauthenticated → login (via requireStaff).
export const load: PageServerLoad = async (event) => {
	requireStaff(event, 'accounts.read');
	throw redirect(303, '/admin/accounts');
};
