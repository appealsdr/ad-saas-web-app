/**
 * POST /auth/impersonation-exit — end an admin "view as user" session and go
 * back to the admin console. Only valid for read-only impersonation sessions.
 */
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { deleteSession } from '$lib/server/auth/session';
import { clearSessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth/cookie';

export const POST: RequestHandler = async (event) => {
	if (!event.locals.readOnly) throw error(400, 'Not a read-only session.');
	const token = event.cookies.get(SESSION_COOKIE_NAME);
	if (token) await deleteSession(token);
	clearSessionCookie(event.cookies, event);
	throw redirect(303, '/admin/accounts');
};
