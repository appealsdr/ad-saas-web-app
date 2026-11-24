/** POST /oauth/revoke — RFC 7009. Revokes the whole connection the token belongs to. Always 200. */
import { json, type RequestHandler } from '@sveltejs/kit';
import { revokeByToken } from '$lib/server/oauth/core';
import { hitRateLimit } from '$lib/server/admin/rate_limit';

export const POST: RequestHandler = async (event) => {
	let ip = 'unknown';
	try { ip = event.getClientAddress(); } catch { /* keep default */ }
	if (!(await hitRateLimit(`oauth-revoke:${ip}`, 60, 60)).allowed) return json({ error: 'temporarily_unavailable' }, { status: 429 });
	const raw = await event.request.text();
	const token = raw.length < 8192 ? new URLSearchParams(raw).get('token') : null;
	if (token) await revokeByToken(token);
	return new Response(null, { status: 200, headers: { 'cache-control': 'no-store' } });
};
