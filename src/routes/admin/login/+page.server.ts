import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientIp } from '$lib/server/admin/guard';
import { safeAdminNext, startStaffLogin } from '$lib/server/admin/auth';
import { setChallengeCookie } from '$lib/server/admin/sessions';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.staff) throw redirect(303, safeAdminNext(url.searchParams.get('next')));
	const raw = url.searchParams.get('next');
	return {
		next: url.searchParams.get('next') ? safeAdminNext(url.searchParams.get('next')) : '',
		expired: url.searchParams.get('expired') === '1',
		signedOut: url.searchParams.get('signedout') === '1'
	};
};

export const actions: Actions = {
	default: async (event) => {
		const data = await event.request.formData();
		const email = String(data.get('email') ?? '').slice(0, 320);
		const password = String(data.get('password') ?? '').slice(0, 1024);
		const next = String(data.get('next') ?? '');

		const result = await startStaffLogin({ email, password, ip: clientIp(event), next }).catch(() => null);
		if (!result) return fail(503, { error: 'Sign-in is temporarily unavailable.', email });
		if (!result.ok) return fail(result.status, { error: result.message, email });

		setChallengeCookie(event.cookies, result.challengeToken);
		throw redirect(303, '/admin/mfa');
	}
};
