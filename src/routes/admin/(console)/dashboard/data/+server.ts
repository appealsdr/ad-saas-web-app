import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requireStaff } from '$lib/server/admin/guard';
import { isValidTimeZone } from '$lib/admin/time';
import { usageDashboard, parseUsageQuery } from '$lib/server/admin/usage';

/** JSON for the dashboard's period switch (no page reload). tz = the admin's saved zone, else the browser's (?tz=). */
export const GET: RequestHandler = async (event) => {
	const staff = requireStaff(event, 'logs.read');
	const asked = event.url.searchParams.get('tz');
	const tz = staff.timeZone ?? (isValidTimeZone(asked) ? asked : 'UTC');
	return json(await usageDashboard(parseUsageQuery(event.url.searchParams, tz)), { headers: { 'cache-control': 'no-store' } });
};
