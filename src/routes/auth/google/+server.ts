/**
 * Start Google OAuth. Generates a CSRF `state`, stashes it (+ the post-login
 * `next` path) in a short-lived HttpOnly cookie, and redirects to Google.
 *
 * Two special modes, mutually exclusive with normal sign-in/sign-up:
 *
 *  - `?link=1` while authenticated switches the callback into "link this
 *    Google identity to my existing (already-signed-in) account" mode. This
 *    is the /accounts "Connect Google Account" button.
 *
 *  - `?reset_token=...` (no session required) lets someone on the forced
 *    /reset-password screen — a newly-provisioned user who has a temp
 *    password but no session yet — connect Google as an alternative to
 *    setting a password. The token is only opaque here; it's validated
 *    against password_reset_tokens in the callback.
 */
import { redirect, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { randomBytes } from 'node:crypto';
import { safeNextUrl } from '$lib/server/auth/redirects';

const GOOGLE_OAUTH_COOKIE = 'g_oauth';

export const GET: RequestHandler = async ({ url, cookies, locals }) => {
	// .env is exposed via $env/dynamic/private (NOT process.env) in SvelteKit.
	const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
	const redirectUri =
		env.GOOGLE_REDIRECT_URI?.trim() || 'http://localhost:5173/auth/google/callback';

	if (!clientId) {
		throw error(503, 'Google sign-in is not configured (GOOGLE_CLIENT_ID is missing).');
	}

	const wantsLink = url.searchParams.get('link') === '1';
	if (wantsLink && !locals.user) {
		// Linking requires an already-authenticated session (e.g. after a temp
		// login). Anonymous requests fall back to normal sign-in/sign-up.
		throw redirect(303, '/login');
	}
	const linkUserId = wantsLink ? locals.user!.id : undefined;
	const resetToken = url.searchParams.get('reset_token')?.trim() || undefined;

	const state = randomBytes(16).toString('base64url');
	const next = safeNextUrl(url.searchParams.get('next')) ?? '';

	cookies.set(GOOGLE_OAUTH_COOKIE, JSON.stringify({ state, next, linkUserId, resetToken }), {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: url.protocol === 'https:',
		maxAge: 600 // 10 min to complete the flow
	});

	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: 'openid email profile',
		access_type: 'offline',
		prompt: 'select_account',
		state
	});

	throw redirect(302, `https://accounts.google.com/o/oauth2/v2/auth?${params}`);
};
