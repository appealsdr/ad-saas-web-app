/**
 * Google OAuth callback.
 *
 *  1. Verify the CSRF `state` against the cookie set in /auth/google.
 *  2. Exchange `code` for tokens; fetch the user's Google profile.
 *  3. Resolve the user:
 *       a. existing oauth_accounts(google, sub) → that user
 *       b. else existing users.email → LINK google to it (sign-in)
 *       c. else CREATE account + owner user (sign-up) with name+email
 *          (company blank), best-effort Salesforce sync like registration.
 *  4. Create a real DB session + HttpOnly cookie, redirect to `next`/dashboard.
 *
 * LINK MODE: if /auth/google was started with `?link=1`, the state cookie
 * carries `linkUserId` (the already-authenticated user requesting the link).
 * In that case we skip session creation/user resolution entirely and just
 * attach this Google identity to that user — after confirming the identity
 * isn't already claimed by a *different* user, and that the caller is still
 * signed in as the same user that started the flow.
 *
 * RESET-TOKEN MODE: if /auth/google was started with `?reset_token=...` (the
 * forced /reset-password screen's "Continue with Google instead" button),
 * the state cookie carries that raw token. There's no session yet — the
 * token itself (same one from password_reset_tokens used by
 * (auth)/reset-password) is the proof of identity. On success this connects
 * Google, clears must_reset_password, consumes the token exactly like
 * setting a password would, and starts a real session.
 */
import { redirect, error } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db';
import { createSession } from '$lib/server/auth/session';
import { setSessionCookie } from '$lib/server/auth/cookie';
import { resolvePostAuthPath } from '$lib/server/auth/redirects';
import { logError, describeError } from '$lib/server/error_log';
import { ensureAccountFolders } from '$lib/server/storage/s3-paths';
import { ensureOwnerAccountContact } from '$lib/server/account/contacts';
import { updateSalesforceContact } from '$lib/server/salesforce/records';

const GOOGLE_OAUTH_COOKIE = 'g_oauth'; // must match /auth/google
const SESSION_COOKIE_MAX_AGE = 60 * 60 * 3; // 3h — matches auth/session.ts TTL

function hashResetToken(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

interface GoogleTokens {
	access_token: string;
	refresh_token?: string;
	expires_in?: number;
	id_token?: string;
}
interface GoogleProfile {
	sub: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
	picture?: string;
}

/** Insert/refresh the oauth_accounts link for a user. */
async function linkGoogle(userId: string, providerUid: string, tokens: GoogleTokens): Promise<void> {
	const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;
	await sql`
		INSERT INTO oauth_accounts (user_id, provider, provider_uid, access_token, refresh_token, expires_at)
		VALUES (${userId}, 'google', ${providerUid}, ${tokens.access_token ?? null}, ${tokens.refresh_token ?? null}, ${expiresAt})
		ON CONFLICT (provider, provider_uid) DO UPDATE SET
			access_token = EXCLUDED.access_token,
			refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_accounts.refresh_token),
			expires_at = EXCLUDED.expires_at
	`;
}

/**
 * Create a fresh account + owner user for a first-time Google sign-up.
 * onboarding_completed = false → the (app) guard sends them to /onboarding to
 * collect company/phone/website. Salesforce sync is DEFERRED until then (so we
 * don't push a placeholder SF Account with no company).
 */
async function createGoogleUser(email: string, displayName: string): Promise<string> {
	const { accountId, userId } = await sql.begin(async (sql) => {
		const [account] = await sql<{ id: string }[]>`
			INSERT INTO accounts (name, email, onboarding_completed)
			VALUES (${displayName}, ${email}, false)
			RETURNING id
		`;
		const [user] = await sql<{ id: string }[]>`
			INSERT INTO users (email, display_name, account_id, role, last_login_at)
			VALUES (${email}, ${displayName}, ${account.id}, 'owner', now())
			RETURNING id
		`;
		return { accountId: account.id, userId: user.id };
	});

	await ensureAccountFolders(accountId);
	await ensureOwnerAccountContact(accountId, userId);
	return userId;
}

export const GET: RequestHandler = async ({ url, cookies, getClientAddress, request, locals }) => {
	const code = url.searchParams.get('code');
	const oauthErr = url.searchParams.get('error');
	const returnedState = url.searchParams.get('state');

	// Consume the state cookie up-front (single use).
	const rawCookie = cookies.get(GOOGLE_OAUTH_COOKIE);
	cookies.delete(GOOGLE_OAUTH_COOKIE, { path: '/' });
	let stored: { state?: string; next?: string; linkUserId?: string; resetToken?: string } = {};
	try {
		stored = rawCookie ? JSON.parse(rawCookie) : {};
	} catch {
		stored = {};
	}

	if (oauthErr) throw error(400, `Google sign-in was cancelled or failed: ${oauthErr}`);
	if (!code) throw error(400, 'Google sign-in: missing authorization code.');
	if (!stored.state || !returnedState || stored.state !== returnedState) {
		throw error(400, 'Google sign-in: invalid or expired request. Please try again.');
	}

	const clientId = env.GOOGLE_CLIENT_ID?.trim() ?? '';
	const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim() ?? '';
	const redirectUri =
		env.GOOGLE_REDIRECT_URI?.trim() || 'http://localhost:5173/auth/google/callback';
	if (!clientId || !clientSecret) throw error(503, 'Google sign-in is not configured.');

	// ── 1. Exchange code for tokens ──
	let tokens: GoogleTokens;
	try {
		const res = await fetch('https://oauth2.googleapis.com/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				code,
				client_id: clientId,
				client_secret: clientSecret,
				redirect_uri: redirectUri,
				grant_type: 'authorization_code'
			})
		});
		if (!res.ok) throw new Error(`token exchange failed (${res.status}): ${await res.text()}`);
		tokens = (await res.json()) as GoogleTokens;
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'auth.google',
			operation: 'token_exchange',
			errorMessage: desc.errorMessage,
			stack: desc.stack
		});
		throw error(502, 'Could not complete Google sign-in (token exchange failed).');
	}

	// ── 2. Fetch the Google profile ──
	let profile: GoogleProfile;
	try {
		const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
			headers: { Authorization: `Bearer ${tokens.access_token}` }
		});
		if (!res.ok) throw new Error(`userinfo failed (${res.status})`);
		profile = (await res.json()) as GoogleProfile;
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'auth.google',
			operation: 'userinfo',
			errorMessage: desc.errorMessage,
			stack: desc.stack
		});
		throw error(502, 'Could not load your Google profile.');
	}

	const providerUid = profile.sub;
	const email = (profile.email ?? '').trim().toLowerCase();
	const displayName = profile.name?.trim() || email;
	if (!providerUid || !email) throw error(502, 'Google did not return an email address.');

	// ── 3. Link mode: attach this Google identity to the already-signed-in
	//        user that started the flow, rather than resolving/creating one. ──
	if (stored.linkUserId) {
		if (!locals.user || locals.user.id !== stored.linkUserId) {
			throw error(401, 'Your session changed during sign-in. Please log in and try linking again.');
		}
		const linkUserId = stored.linkUserId;

		const [claimedBy] = await sql<{ user_id: string }[]>`
			SELECT user_id FROM oauth_accounts
			WHERE provider = 'google' AND provider_uid = ${providerUid} LIMIT 1
		`;
		if (claimedBy && claimedBy.user_id !== linkUserId) {
			throw error(409, 'That Google account is already linked to a different Appeals Doctor account.');
		}

		try {
			await linkGoogle(linkUserId, providerUid, tokens);
			await sql`
				UPDATE users
				SET avatar_url = COALESCE(avatar_url, ${profile.picture ?? null})
				WHERE id = ${linkUserId}
			`;
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'auth.google',
				operation: 'link_existing_user',
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { userId: linkUserId, email }
			});
			throw error(500, 'Could not link your Google account. Please try again.');
		}

		throw redirect(303, resolvePostAuthPath(stored.next || null));
	}

	// ── 3a. Reset-token mode: connect Google as an alternative to setting a
	//        password, using the forced-reset token as proof of identity. ──
	if (stored.resetToken) {
		const tokenHash = hashResetToken(stored.resetToken);
		const [tokenRow] = await sql<{ id: string; user_id: string; sfdc_contact_id: string | null }[]>`
			SELECT prt.id, prt.user_id, u.sfdc_contact_id
			FROM password_reset_tokens prt
			JOIN users u ON u.id = prt.user_id
			WHERE prt.token_hash = ${tokenHash}
			  AND prt.used_at IS NULL
			  AND prt.expires_at > now()
			LIMIT 1
		`;
		if (!tokenRow) {
			throw error(400, 'This reset link is invalid or has expired. Please request a new one.');
		}
		const resetUserId = tokenRow.user_id;

		const [claimedBy] = await sql<{ user_id: string }[]>`
			SELECT user_id FROM oauth_accounts
			WHERE provider = 'google' AND provider_uid = ${providerUid} LIMIT 1
		`;
		if (claimedBy && claimedBy.user_id !== resetUserId) {
			throw error(409, 'That Google account is already linked to a different Appeals Doctor account.');
		}

		try {
			await sql.begin(async (tx) => {
				await tx`
					INSERT INTO oauth_accounts (user_id, provider, provider_uid, access_token, refresh_token, expires_at)
					VALUES (
						${resetUserId}, 'google', ${providerUid}, ${tokens.access_token ?? null},
						${tokens.refresh_token ?? null},
						${tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null}
					)
					ON CONFLICT (provider, provider_uid) DO UPDATE SET
						access_token = EXCLUDED.access_token,
						refresh_token = COALESCE(EXCLUDED.refresh_token, oauth_accounts.refresh_token),
						expires_at = EXCLUDED.expires_at
				`;
				await tx`
					UPDATE users
					SET must_reset_password = false, avatar_url = COALESCE(avatar_url, ${profile.picture ?? null})
					WHERE id = ${resetUserId}
				`;
				await tx`UPDATE password_reset_tokens SET used_at = now() WHERE id = ${tokenRow.id}`;
			});
			if (tokenRow.sfdc_contact_id) {
				// Best-effort — same fields the password-based reset clears.
				await updateSalesforceContact(
					tokenRow.sfdc_contact_id,
					{ Temp_Password_For_App__c: null, Password_Reset_At__c: new Date().toISOString() },
					{ userId: resetUserId }
				);
			}
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'auth.google',
				operation: 'link_via_reset_token',
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { userId: resetUserId, email }
			});
			throw error(500, 'Could not connect your Google account. Please try again.');
		}

		const { rawToken } = await createSession(resetUserId, {
			ipAddress: getClientAddress(),
			userAgent: request.headers.get('user-agent') ?? undefined
		});
		setSessionCookie(cookies, { url }, rawToken, SESSION_COOKIE_MAX_AGE);
		throw redirect(303, resolvePostAuthPath(stored.next || null));
	}

	// ── 3b. Resolve / create the user (normal sign-in/sign-up) ──
	let userId: string;
	try {
		const [linked] = await sql<{ user_id: string }[]>`
			SELECT user_id FROM oauth_accounts
			WHERE provider = 'google' AND provider_uid = ${providerUid} LIMIT 1
		`;
		if (linked) {
			userId = linked.user_id;
		} else {
			const [existing] = await sql<{ id: string }[]>`
				SELECT id FROM users WHERE email = ${email} LIMIT 1
			`;
			if (existing) {
				userId = existing.id; // link by email (sign-in)
				await linkGoogle(userId, providerUid, tokens);
			} else {
				userId = await createGoogleUser(email, displayName); // sign-up
				await linkGoogle(userId, providerUid, tokens);
			}
		}
		await sql`
			UPDATE users
			SET last_login_at = now(),
			    display_name = COALESCE(display_name, ${displayName}),
			    avatar_url = COALESCE(avatar_url, ${profile.picture ?? null})
			WHERE id = ${userId}
		`;
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'auth.google',
			operation: 'resolve_user',
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { email }
		});
		throw error(500, 'Could not sign you in. Please try again.');
	}

	// ── 4. Real session ──
	const { rawToken } = await createSession(userId, {
		ipAddress: getClientAddress(),
		userAgent: request.headers.get('user-agent') ?? undefined
	});
	setSessionCookie(cookies, { url }, rawToken, SESSION_COOKIE_MAX_AGE);

	throw redirect(303, resolvePostAuthPath(stored.next || null));
};
