import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ADMIN_SESSION_COOKIE, clearAdminSessionCookie, revokeAdminSession } from '$lib/server/admin/sessions';
import { recordAudit } from '$lib/server/admin/audit';
import { auditActor, clientIp } from '$lib/server/admin/guard';
import { safeAdminNext } from '$lib/server/admin/auth';

// POST only (state-changing; origin-checked in hooks). GET falls through to 405.
export const POST: RequestHandler = async (event) => {
	const token = event.cookies.get(ADMIN_SESSION_COOKIE);
	if (token) await revokeAdminSession(token, 'logout', event.locals.staff?.userId).catch(() => {});
	if (event.locals.staff) {
		await recordAudit({ actor: auditActor(event.locals.staff), action: 'staff.logout', outcome: 'success', ip: clientIp(event) }, undefined, { bestEffort: true });
	}
	clearAdminSessionCookie(event.cookies);
	// Optional: come back to the page that needed a fresh sign-in (validated; only /admin paths are allowed).
	const form = await event.request.formData().catch(() => null);
	const raw = form ? String(form.get('next') ?? '') : '';
	const next = raw ? safeAdminNext(raw) : '';
	throw redirect(303, `/admin/login?signedout=1${next && raw ? `&next=${encodeURIComponent(next)}` : ''}`);
};
