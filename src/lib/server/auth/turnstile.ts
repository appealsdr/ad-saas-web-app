/**
 * Cloudflare Turnstile verification (server side).
 *
 * Configure with TURNSTILE_SECRET_KEY (private) and PUBLIC_TURNSTILE_SITE_KEY (public). When the secret is not
 * set the check is skipped (local dev / CI) — set it in staging and production. When it IS set, a missing or
 * invalid token, or Cloudflare being unreachable, rejects the signup (fail closed).
 */
import { env } from '$env/dynamic/private';

export function turnstileEnabled(): boolean {
	return !!env.TURNSTILE_SECRET_KEY;
}

export async function verifyTurnstile(token: string, remoteIp?: string): Promise<boolean> {
	const secret = env.TURNSTILE_SECRET_KEY;
	if (!secret) return true;
	if (!token) return false;
	try {
		const body = new URLSearchParams({ secret, response: token });
		if (remoteIp) body.set('remoteip', remoteIp);
		const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
			method: 'POST',
			body,
			signal: AbortSignal.timeout(5000)
		});
		if (!res.ok) return false;
		return ((await res.json()) as { success?: boolean }).success === true;
	} catch {
		return false;
	}
}
