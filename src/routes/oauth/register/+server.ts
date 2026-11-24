/** POST /oauth/register — RFC 7591 dynamic client registration (public clients only). */
import { json, type RequestHandler } from '@sveltejs/kit';
import { registerClient, OAuthError } from '$lib/server/oauth/core';
import { JSON_HEADERS } from '$lib/server/oauth/meta';
import { hitRateLimit } from '$lib/server/admin/rate_limit';

export const POST: RequestHandler = async (event) => {
	let ip = 'unknown';
	try { ip = event.getClientAddress(); } catch { /* keep default */ }
	if (!(await hitRateLimit(`oauth-register:${ip}`, 20, 3600)).allowed) {
		return json({ error: 'temporarily_unavailable', error_description: 'Too many registrations.' }, { status: 429, headers: JSON_HEADERS });
	}
	let body: Record<string, unknown>;
	try {
		const text = await event.request.text();
		if (text.length > 16 * 1024) throw new Error('large');
		body = JSON.parse(text);
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
	} catch {
		return json({ error: 'invalid_client_metadata', error_description: 'Body must be a JSON object.' }, { status: 400, headers: JSON_HEADERS });
	}
	try {
		const c = await registerClient(body.client_name, body.redirect_uris);
		return json({
			client_id: c.client_id, client_name: c.client_name, redirect_uris: c.redirect_uris,
			token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']
		}, { status: 201, headers: JSON_HEADERS });
	} catch (e) {
		if (e instanceof OAuthError) return json({ error: e.code, error_description: e.message }, { status: 400, headers: JSON_HEADERS });
		throw e;
	}
};
