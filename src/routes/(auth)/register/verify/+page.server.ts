/**
 * Email verification landing (AD-1946). A valid token clears the pending flag, runs the deferred signup work
 * (S3 folders + Salesforce Account/Contact) and signs the user in. Invalid/expired tokens get a resend form.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { consumeVerificationToken, createVerificationToken } from '$lib/server/auth/email_verification';
import { finalizeSignup } from '$lib/server/auth/finalize_signup';
import { createSession } from '$lib/server/auth/session';
import { setSessionCookie } from '$lib/server/auth/cookie';
import { resolvePostAuthPath } from '$lib/server/auth/redirects';
import { hitRateLimit } from '$lib/server/admin/rate_limit';
import { sendVerificationEmail } from '$lib/server/salesforce/email';
import { logError, describeError } from '$lib/server/error_log';

const SESSION_COOKIE_MAX_AGE = 60 * 60 * 3; // must match auth/session.ts TTL

export const load: PageServerLoad = async ({ url, cookies, getClientAddress, request }) => {
	const token = url.searchParams.get('token') ?? '';
	const res = await consumeVerificationToken(token);
	if (!res.ok) {
		if (res.reason === 'used') throw redirect(303, '/login?verified=1');
		return { problem: res.reason as 'invalid' | 'expired' };
	}
	try {
		await finalizeSignup(res.userId);
	} catch (e) {
		// The email IS verified; Salesforce/S3 work is best-effort and already logs its own failures.
		const d = describeError(e);
		await logError({ source: 'register', operation: 'finalize_signup', userId: res.userId, errorMessage: d.errorMessage, stack: d.stack });
	}
	let ip: string | undefined;
	try { ip = getClientAddress(); } catch { /* none */ }
	const { rawToken } = await createSession(res.userId, { ipAddress: ip, userAgent: request.headers.get('user-agent') ?? undefined });
	setSessionCookie(cookies, { url }, rawToken, SESSION_COOKIE_MAX_AGE);
	await sql`UPDATE users SET last_login_at = now() WHERE id = ${res.userId}`.catch(() => {});
	throw redirect(303, resolvePostAuthPath(null));
};

export const actions: Actions = {
	resend: async ({ request, url }) => {
		const email = String((await request.formData()).get('email') ?? '').trim().toLowerCase();
		if (!email || email.length > 254) return fail(400, { error: 'Please enter your email address.' });
		const lim = await hitRateLimit(`signup:resend:${email}`, 3, 3600);
		if (lim.allowed) {
			const [u] = await sql<{ id: string }[]>`SELECT id FROM users WHERE email = ${email} AND email_verification_pending LIMIT 1`;
			if (u) {
				try {
					const raw = await createVerificationToken(u.id, email);
					await sendVerificationEmail(email, `${url.origin}/register/verify?token=${raw}`, { userId: u.id });
				} catch { /* logged inside sendVerificationEmail */ }
			}
		}
		// Same response whether or not the address exists / is pending (no account enumeration).
		return { sent: true };
	}
};
