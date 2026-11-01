import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientIp } from '$lib/server/admin/guard';
import {
	consumeChallenge,
	loadChallenge,
	registerChallengeFailure,
	safeAdminNext
} from '$lib/server/admin/auth';
import {
	ADMIN_CHALLENGE_COOKIE,
	ADMIN_SESSION_COOKIE,
	clearChallengeCookie,
	createAdminSession,
	lookupAdminSession,
	setAdminSessionCookie
} from '$lib/server/admin/sessions';
import { consumeRecoveryCode, getOrCreateEnrollment, issueRecoveryCodes, verifyTotp } from '$lib/server/admin/mfa';
import { MfaKeyMissingError } from '$lib/server/admin/crypto';
import { recordAudit } from '$lib/server/admin/audit';

export const load: PageServerLoad = async ({ cookies, locals }) => {
	if (locals.staff) throw redirect(303, '/admin/accounts');
	const challenge = await loadChallenge(cookies.get(ADMIN_CHALLENGE_COOKIE));
	if (!challenge) {
		// Right after a successful verification the action has already set the admin
		// session cookie and consumed the challenge, and SvelteKit re-runs this load in
		// the same request. Don't bounce to login in that case — the page shows the
		// one-time recovery codes held in the action result.
		const justAuthenticated = await lookupAdminSession(cookies.get(ADMIN_SESSION_COOKIE)).catch(() => null);
		if (justAuthenticated?.status === 'ok') {
			return { stage: 'done' as 'mfa_enroll' | 'mfa_challenge' | 'done', email: justAuthenticated.staff.email, qrSvg: '', secret: '', configError: null as string | null };
		}
		clearChallengeCookie(cookies);
		throw redirect(303, '/admin/login?expired=1');
	}
	if (challenge.stage === 'mfa_enroll') {
		try {
			const e = await getOrCreateEnrollment(challenge.userId, challenge.email);
			return { stage: challenge.stage as 'mfa_enroll' | 'mfa_challenge' | 'done', email: challenge.email, qrSvg: e.qrSvg, secret: e.secret, configError: null as string | null };
		} catch (err) {
			const msg = err instanceof MfaKeyMissingError ? err.message : 'Could not start MFA enrollment.';
			return { stage: challenge.stage as 'mfa_enroll' | 'mfa_challenge' | 'done', email: challenge.email, qrSvg: '', secret: '', configError: msg };
		}
	}
	return { stage: challenge.stage as 'mfa_enroll' | 'mfa_challenge' | 'done', email: challenge.email, qrSvg: '', secret: '', configError: null as string | null };
};

export const actions: Actions = {
	default: async (event) => {
		const { cookies, request } = event;
		const ip = clientIp(event);
		const challenge = await loadChallenge(cookies.get(ADMIN_CHALLENGE_COOKIE));
		if (!challenge) {
			clearChallengeCookie(cookies);
			throw redirect(303, '/admin/login?expired=1');
		}
		const data = await request.formData();
		const code = String(data.get('code') ?? '').trim().slice(0, 32);
		const recovery = String(data.get('recovery') ?? '').trim().slice(0, 64);
		const useRecovery = recovery !== '' && challenge.stage === 'mfa_challenge';

		const actor = { userId: challenge.userId, ref: challenge.email, role: challenge.role };
		let ok = false;
		let method: 'totp' | 'recovery' | 'enroll' = 'totp';
		try {
			if (challenge.stage === 'mfa_enroll') {
				method = 'enroll';
				ok = await verifyTotp(challenge.userId, code, { confirm: true });
			} else if (useRecovery) {
				method = 'recovery';
				ok = await consumeRecoveryCode(challenge.userId, recovery);
			} else {
				ok = await verifyTotp(challenge.userId, code);
			}
		} catch {
			return fail(503, { error: 'Verification is temporarily unavailable.' });
		}

		if (!ok) {
			const state = await registerChallengeFailure(challenge.id, challenge.userId);
			await recordAudit({ actor, action: 'staff.mfa', outcome: 'failure', ip, metadata: { method } }, undefined, { bestEffort: true });
			if (!state.stillValid) {
				clearChallengeCookie(cookies);
				throw redirect(303, '/admin/login?expired=1');
			}
			return fail(401, { error: 'That code is not valid.' });
		}

		// Single-winner consume: a concurrent/replayed request cannot mint a second session.
		if (!(await consumeChallenge(challenge.id))) {
			clearChallengeCookie(cookies);
			throw redirect(303, '/admin/login?expired=1');
		}
		const recoveryCodes = challenge.stage === 'mfa_enroll' ? await issueRecoveryCodes(challenge.userId) : null;
		const { rawToken } = await createAdminSession(challenge.userId, { ip, userAgent: request.headers.get('user-agent') });
		setAdminSessionCookie(cookies, rawToken); // new token on every completed authentication
		clearChallengeCookie(cookies);
		await recordAudit({ actor, action: 'staff.login', outcome: 'success', ip, metadata: { method } }, undefined, { bestEffort: true });
		if (method === 'recovery') {
			await recordAudit({ actor, action: 'staff.mfa_recovery_used', outcome: 'success', ip }, undefined, { bestEffort: true });
		}
		const next = safeAdminNext(challenge.nextPath);
		if (recoveryCodes) return { recoveryCodes, next };
		throw redirect(303, next);
	}
};
