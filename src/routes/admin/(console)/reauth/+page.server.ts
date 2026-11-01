import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auditActor, clientIp, requireStaff } from '$lib/server/admin/guard';
import { safeAdminNext, MAX_MFA_PER_USER, LOGIN_WINDOW_SECONDS } from '$lib/server/admin/auth';
import { verifyTotp } from '$lib/server/admin/mfa';
import { markMfaFresh } from '$lib/server/admin/sessions';
import { hitRateLimit } from '$lib/server/admin/rate_limit';
import { recordAudit } from '$lib/server/admin/audit';

export const load: PageServerLoad = async (event) => {
	requireStaff(event);
	return { next: safeAdminNext(event.url.searchParams.get('next')) };
};

export const actions: Actions = {
	default: async (event) => {
		const staff = requireStaff(event);
		const data = await event.request.formData();
		const next = safeAdminNext(String(data.get('next') ?? ''));
		const limit = await hitRateLimit(`admin-mfa:user:${staff.userId}`, MAX_MFA_PER_USER, LOGIN_WINDOW_SECONDS);
		if (!limit.allowed) return fail(429, { error: 'Too many attempts. Try again later.' });
		const ok = await verifyTotp(staff.userId, String(data.get('code') ?? ''));
		await recordAudit({ actor: auditActor(staff), action: 'staff.reauth', outcome: ok ? 'success' : 'failure', ip: clientIp(event) }, undefined, { bestEffort: true });
		if (!ok) return fail(401, { error: 'That code is not valid (a code can only be used once — wait for the next one).' });
		await markMfaFresh(staff.sessionId);
		throw redirect(303, next);
	}
};
