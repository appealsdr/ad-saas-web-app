/** POST /oauth/token — authorization_code (PKCE) and refresh_token grants. */
import { json, type RequestHandler } from '@sveltejs/kit';
import { exchangeCode, refreshTokens, getClient, OAuthError } from '$lib/server/oauth/core';
import { JSON_HEADERS, publicOrigin } from '$lib/server/oauth/meta';
import { hitRateLimit } from '$lib/server/admin/rate_limit';

const err = (code: string, description: string, status = 400) =>
	json({ error: code, error_description: description }, { status, headers: JSON_HEADERS });

export const POST: RequestHandler = async (event) => {
	let ip = 'unknown';
	try { ip = event.getClientAddress(); } catch { /* keep default */ }
	if (!(await hitRateLimit(`oauth-token:${ip}`, 60, 60)).allowed) return err('temporarily_unavailable', 'Too many requests.', 429);

	const ct = (event.request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
	if (ct !== 'application/x-www-form-urlencoded') return err('invalid_request', 'Use application/x-www-form-urlencoded.');
	const raw = await event.request.text();
	if (raw.length > 8192) return err('invalid_request', 'Request too large.');
	const f = new URLSearchParams(raw);
	const clientId = f.get('client_id') ?? '';
	if (!(await getClient(clientId))) return err('invalid_client', 'Unknown client.', 401);

	try {
		let tokens;
		if (f.get('grant_type') === 'authorization_code') {
			const origin = publicOrigin(event.url.origin);
			const resource = f.get('resource');
			if (resource && resource !== `${origin}/mcp`) return err('invalid_target', 'Unknown resource.');
			tokens = await exchangeCode({
				code: f.get('code') ?? '', clientId, redirectUri: f.get('redirect_uri') ?? '', verifier: f.get('code_verifier') ?? '', resource
			});
		} else if (f.get('grant_type') === 'refresh_token') {
			tokens = await refreshTokens({ refreshToken: f.get('refresh_token') ?? '', clientId });
		} else {
			return err('unsupported_grant_type', 'Unsupported grant_type.');
		}
		return json(tokens, { headers: JSON_HEADERS });
	} catch (e) {
		if (e instanceof OAuthError) return err(e.code, e.message, e.status);
		throw e;
	}
};
