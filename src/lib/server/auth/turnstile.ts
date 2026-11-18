/**
 * Cloudflare Turnstile verification (server side).
 *
 * Configure with TURNSTILE_SECRET_KEY (private) and PUBLIC_TURNSTILE_SITE_KEY (public). When the secret is not
 * set the check is skipped (local dev / CI) — set it in staging and production. When it IS set, a missing or
 * invalid token, or Cloudflare being unreachable, rejects the signup (fail closed).
 *
 * The widget is rendered with data-action "signup", and siteverify must echo that action back. Optionally set
 * TURNSTILE_HOSTNAMES (comma-separated frontend hostnames, e.g. app.appealsdoctor.com) to also require the
 * token to have been issued on one of them; never include localhost in production.
 */
import { env } from '$env/dynamic/private';

export function turnstileEnabled(): boolean {
	return !!env.TURNSTILE_SECRET_KEY;
}

export const TURNSTILE_ACTION = 'signup';

export async function verifyTurnstile(token: string, remoteIp?: string): Promise<boolean> {
	const secret = env.TURNSTILE_SECRET_KEY;
	if (!secret) return true;
	if (!token || token.length > 2048) return false;
	try {
		const body = new URLSearchParams({ secret, response: token });
		if (remoteIp) body.set('remoteip', remoteIp);
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			body,
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) return false;
		const r = (await res.json()) as { success?: boolean; action?: string; hostname?: string };
		if (r.success !== true || r.action !== TURNSTILE_ACTION) return false;
		const hosts = (env.TURNSTILE_HOSTNAMES ?? '').split(',').map((h) => h.trim()).filter(Boolean);
		return hosts.length === 0 || hosts.includes(r.hostname ?? '');
	} catch {
		return false;
	}
}
