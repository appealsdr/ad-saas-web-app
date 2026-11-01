/**
 * POST /api/activity — batched page-view / click events from the signed-in
 * user's browser. Shaped + clipped server-side; anonymous callers get 401.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { logActivity, shapeClientEvent } from '$lib/server/activity';

export const POST: RequestHandler = async ({ request, locals, getClientAddress }) => {
	if (!locals.user) throw error(401, 'Sign in required.');
	let body: { events?: unknown[] };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON.');
	}
	const events = Array.isArray(body.events) ? body.events.slice(0, 50) : [];
	let ip: string | null = null;
	try { ip = getClientAddress(); } catch { /* behind a proxy without address */ }
	let n = 0;
	for (const raw of events) {
		const ev = shapeClientEvent(raw);
		if (!ev) continue;
		logActivity({ userId: locals.user.id, accountId: locals.accountId, sessionId: locals.sessionId, type: ev.type, data: ev.data, at: ev.at, ip, requestId: locals.requestId });
		n++;
	}
	return json({ accepted: n });
};
