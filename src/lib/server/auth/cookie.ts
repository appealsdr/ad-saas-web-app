/**
 * Session cookie utilities — single source of truth so login, register, and
 * (future) OAuth callbacks set identical attributes.
 *
 * Why `sameSite: 'lax'` (not 'strict'):
 *   With 'strict' the browser refuses to send the cookie on ANY navigation
 *   that originated from another site — including the Amazon SP-API OAuth
 *   redirect chain. Even after the redirect lands back on our domain, the
 *   browser still treats the navigation as cross-site-initiated and strips
 *   the cookie. The user then appears signed-out on the post-OAuth page.
 *   'lax' allows the cookie on top-level GET navigations, which covers
 *   every OAuth-style return flow we care about while still blocking
 *   cross-site POSTs (the actual CSRF surface).
 *
 * Why detect HTTPS instead of hard-coding `secure`:
 *   Dev runs at http://localhost AND https://*.ngrok-free.dev simultaneously.
 *   We want the cookie to work on both. `Secure` flag is set whenever the
 *   request that's setting the cookie is itself over HTTPS.
 */
import type { Cookies, RequestEvent } from '@sveltejs/kit';

export const SESSION_COOKIE_NAME = 'session';
export const SESSION_COOKIE_MAX_AGE = 60 * 60 * 3; // 3h — matches auth/session.ts TTL

function isHttps(event: Pick<RequestEvent, 'url'>): boolean {
	return event.url.protocol === 'https:';
}

export function setSessionCookie(
	cookies: Cookies,
	event: Pick<RequestEvent, 'url'>,
	value: string,
	maxAge: number = SESSION_COOKIE_MAX_AGE
): void {
	cookies.set(SESSION_COOKIE_NAME, value, {
		path: '/',
		httpOnly: true,
		secure: isHttps(event),
		sameSite: 'lax',
		maxAge
	});
}

export function clearSessionCookie(
	cookies: Cookies,
	event: Pick<RequestEvent, 'url'>
): void {
	cookies.delete(SESSION_COOKIE_NAME, {
		path: '/',
		httpOnly: true,
		secure: isHttps(event),
		sameSite: 'lax'
	});
}
