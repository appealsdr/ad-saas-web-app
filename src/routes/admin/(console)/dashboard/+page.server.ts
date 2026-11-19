import type { PageServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';
import { resolveTimeZone } from '$lib/admin/time';
import { usageDashboard, parseUsageQuery } from '$lib/server/admin/usage';

export const load: PageServerLoad = async (event) => {
	const staff = requireStaff(event, 'logs.read');
	// Browser zone is unknown server-side; the page re-requests with it when the admin has no saved zone.
	const tz = staff.timeZone && resolveTimeZone(staff.timeZone) === staff.timeZone ? staff.timeZone : 'UTC';
	const initial = await usageDashboard(parseUsageQuery(event.url.searchParams, tz));
	return { initial, hasSavedTz: !!staff.timeZone };
};
