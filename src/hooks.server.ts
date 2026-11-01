/**
 * Auth middleware.
 *
 * Reads the `session` cookie (a raw token), looks up the matching row in the
 * sessions table, and attaches the user to `event.locals.user`. If the cookie
 * is missing, unknown, or expired, `event.locals.user` is set to null and the
 * stale cookie is cleared.
 *
 * Falls back gracefully when the DB is unreachable so a brief Postgres outage
 * doesn't take the whole site down — anonymous traffic still loads.
 */
import { randomUUID } from 'node:crypto';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { json } from '@sveltejs/kit';
import { logActivity } from '$lib/server/activity';
import { getSessionUser } from '$lib/server/auth/session';
import { clearSessionCookie } from '$lib/server/auth/cookie';
import { requestContext } from '$lib/server/admin/request_context';
import {
	ADMIN_SESSION_COOKIE,
	clearAdminSessionCookie,
	lookupAdminSession
} from '$lib/server/admin/sessions';
import { adminOriginOk } from '$lib/server/admin/origin';
import { env } from '$env/dynamic/private';

/** Paths that are governed by PLATFORM STAFF auth (separate cookie/session) instead of customer auth. */
function isAdminPath(pathname: string): boolean {
	return (
		pathname === '/admin' ||
		pathname.startsWith('/admin/') ||
		pathname.startsWith('/api/aws/diagnostic') ||
		pathname.startsWith('/api/sfdc/diagnostic')
	);
}

async function handleAdmin(event: RequestEvent, resolve: Parameters<Handle>[0]['resolve']) {
	event.locals.user = null; // customer identity is never used on admin paths
	event.locals.staff = null;

	if (
		!adminOriginOk({
			method: event.request.method,
			origin: event.request.headers.get('origin'),
			secFetchSite: event.request.headers.get('sec-fetch-site'),
			requestOrigin: event.url.origin,
			configuredOrigin: env.ORIGIN
		})
	) {
		return json({ message: 'Cross-origin request rejected.' }, { status: 403 });
	}

	const token = event.cookies.get(ADMIN_SESSION_COOKIE);
	if (token) {
		try {
			const result = await lookupAdminSession(token);
			if (result.status === 'ok') event.locals.staff = result.staff;
			else clearAdminSessionCookie(event.cookies);
		} catch (e) {
			// Fail closed: no staff identity if verification fails.
			console.error('hooks.server: admin session lookup failed', e instanceof Error ? e.message : e);
			event.locals.staff = null;
		}
	}
	if (event.locals.staff) {
		requestContext.getStore()!.userId = event.locals.staff.userId;
	}
	event.setHeaders({
		'cache-control': 'no-store, private',
		'x-frame-options': 'DENY',
		'x-content-type-options': 'nosniff',
		'referrer-policy': 'no-referrer'
	});
	return resolve(event);
}

export const handle: Handle = async ({ event, resolve }) => {
	const requestId = randomUUID();
	event.locals.requestId = requestId;
	event.setHeaders({ 'x-request-id': requestId });
	return requestContext.run({ requestId }, () => {
		if (isAdminPath(event.url.pathname)) return handleAdmin(event, resolve);
		return handleCustomer({ event, resolve });
	});
};

/**
 * Read-only ("view as user") sessions may browse but never change anything:
 * every non-GET request is rejected (except sign-out / leaving the session), as
 * are the GET routes that start an outbound OAuth connection.
 */
const RO_ALLOWED_WRITES = new Set(['/auth/logout', '/auth/impersonation-exit']);
const RO_BLOCKED_GETS = ['/auth/spapi', '/auth/google'];
function readOnlyBlock(event: RequestEvent): Response | null {
	const { pathname } = event.url;
	const safe = ['GET', 'HEAD', 'OPTIONS'].includes(event.request.method);
	const blockedGet = safe && RO_BLOCKED_GETS.some((p) => pathname === p || pathname.startsWith(p + '/'));
	if ((safe && !blockedGet) || RO_ALLOWED_WRITES.has(pathname)) return null;
	return json({ message: 'Read-only mode: this session can view but not change anything.' }, { status: 403 });
}

const handleCustomer: Handle = async ({ event, resolve }) => {
	event.locals.staff = null; // platform staff identity is never derived from a customer session
	event.locals.readOnly = false;
	event.locals.impersonatedBy = null;
	event.locals.accountId = null;
	event.locals.sessionId = null;
	const sessionToken = event.cookies.get('session');

	if (!sessionToken) {
		event.locals.user = null;
		return resolve(event);
	}

	try {
		const session = await getSessionUser(sessionToken);
		if (session) {
			event.locals.user = {
				id: session.userId,
				email: session.email,
				displayName: session.displayName ?? session.email,
				avatarUrl: session.avatarUrl ?? undefined,
				sfdcContactId: session.sfdcContactId ?? undefined,
				sfdcAccountId: session.sfdcAccountId ?? undefined,
				createdAt: new Date().toISOString()
			};
			event.locals.accountId = session.accountId;
			event.locals.sessionId = session.sessionId;
			event.locals.readOnly = session.readOnly;
			event.locals.impersonatedBy = session.impersonatedByEmail;
			if (session.readOnly) {
				const blocked = readOnlyBlock(event);
				if (blocked) return blocked;
			}
		} else {
			// Token didn't match a live session — clear the bad cookie.
			event.locals.user = null;
			clearSessionCookie(event.cookies, event);
		}
	} catch (e) {
		console.error('hooks.server: session lookup failed', e);
		event.locals.user = null;
	}

	const response = await resolve(event);
	trackAction(event, response.status);
	return response;
};

/** Record submitted changes (form actions / API writes) by real users. Read-only admin views are never logged. */
function trackAction(event: RequestEvent, status: number) {
	const u = event.locals.user;
	if (!u || event.locals.readOnly) return;
	if (['GET', 'HEAD', 'OPTIONS'].includes(event.request.method)) return;
	const { pathname, search } = event.url;
	if (pathname === '/api/activity') return;
	let ip: string | null = null;
	try { ip = event.getClientAddress(); } catch { /* no address */ }
	logActivity({
		userId: u.id,
		accountId: event.locals.accountId,
		sessionId: event.locals.sessionId,
		type: pathname === '/auth/logout' ? 'logout' : 'action',
		data: { method: event.request.method, path: pathname, action: search.startsWith('?/') ? search.slice(2).split('&')[0] : undefined, status },
		ip,
		requestId: event.locals.requestId
	});
}
