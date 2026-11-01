import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_SESSION_COOKIE, clearAdminSessionCookie, revokeAdminSession } from '$lib/server/admin/sessions';
import { recordAudit } from '$lib/server/admin/audit';
import { auditActor, clientIp } from '$lib/server/admin/guard';

// POST only (state-changing; origin-checked in hooks). GET falls through to 405.
export const POST: RequestHandler = async (event) => {
	const token = event.cookies.get(ADMIN_SESSION_COOKIE);
	if (token) await revokeAdminSession(token, 'logout', event.locals.staff?.userId).catch(() => {});
	if (event.locals.staff) {
		await recordAudit({ actor: auditActor(event.locals.staff), action: 'staff.logout', outcome: 'success', ip: clientIp(event) }, undefined, { bestEffort: true });
	}
	clearAdminSessionCookie(event.cookies);
	throw redirect(303, '/admin/login?signedout=1');
};
