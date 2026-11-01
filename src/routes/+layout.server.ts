import type { LayoutServerLoad } from './$types';

// Runs on every request — passes session user to all layouts/pages.
export const load: LayoutServerLoad = async ({ locals }) => {
	return {
		user: locals.user ?? null,
		// Admin "view as user" session: pages disable anything that would change data.
		readOnly: locals.readOnly ?? false,
		impersonatedBy: locals.impersonatedBy ?? null
	};
};
