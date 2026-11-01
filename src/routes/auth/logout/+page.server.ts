/**
 * Logout — delete the DB session row, then clear the cookie, then redirect.
 *
 * Order matters: deleteSession() looks up the row by the raw token, so we
 * must do that BEFORE removing the cookie. If the DB delete fails we still
 * proceed to clear the cookie + redirect — the worst case is an orphan
 * session row that expires on its own three hours later.
 */
import { redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { deleteSession } from '$lib/server/auth/session';
import { clearSessionCookie } from '$lib/server/auth/cookie';
import { logError, describeError } from '$lib/server/error_log';

export const actions: Actions = {
	default: async ({ cookies, locals, url }) => {
		const token = cookies.get('session');
		if (token) {
			try {
				await deleteSession(token);
			} catch (e) {
				const desc = describeError(e);
				await logError({
					source: 'logout',
					operation: 'delete_session',
					severity: 'warn',
					userId: locals.user?.id ?? null,
					errorMessage: desc.errorMessage,
					stack: desc.stack
				});
				// Fall through — still clear the cookie + redirect.
			}
		}
		clearSessionCookie(cookies, { url });
		throw redirect(303, '/login');
	}
};
