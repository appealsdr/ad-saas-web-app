/**
 * GET /redirect
 *
 * Temporary duplicate of /auth/spapi (see src/routes/auth/spapi/+server.ts)
 * so both URIs work while the Solution Provider Portal has this path
 * registered as the OAuth redirect URI instead of /auth/spapi. Once the
 * portal config is settled on one URI, delete whichever route is unused.
 */
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import {
	buildConsentUrl,
	createOauthState,
	pruneExpiredOauthStates,
	getSpapiConfig
} from '$lib/server/spapi';
import { logError, describeError } from '$lib/server/error_log';

export const GET: RequestHandler = async ({ url, locals }) => {
	// Amazon SP-API redirects the OAuth *result* to the app's registered redirect
	// URI, which is configured as /redirect (this route) rather than
	// /auth/spapi/callback. Detect the callback params and forward to the real
	// callback handler (preserving the query string) so the connection completes
	// instead of 400-ing on the missing `store` param below. Runs before the auth
	// check because the cross-site redirect may not carry the session cookie — the
	// callback re-issues a session from the (single-use) OAuth state it consumes.
	const p = url.searchParams;
	if (
		p.has('spapi_oauth_code') ||
		p.has('selling_partner_id') ||
		((p.has('error') || p.has('error_description')) && p.has('state'))
	) {
		throw redirect(303, `/auth/spapi/callback${url.search}`);
	}

	if (!locals.user) throw redirect(303, '/login');

	const storeId = url.searchParams.get('store')?.trim();
	if (!storeId) throw error(400, 'Missing store parameter.');

	const [row] = await sql<{ account_id: string }[]>`
		SELECT s.account_id
		FROM stores s JOIN users u ON u.id = ${locals.user.id}
		WHERE s.id = ${storeId} AND s.account_id = u.account_id
		LIMIT 1
	`;
	if (!row) throw error(404, 'Store not found.');

	// Config check up-front so missing env produces a clear 503 instead of a
	// generic 500 from deeper in the call chain.
	try {
		getSpapiConfig();
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'spapi.connect',
			operation: 'config',
			userId: locals.user.id,
			accountId: row.account_id,
			errorMessage: desc.errorMessage,
			stack: desc.stack
		});
		throw error(
			503,
			`Amazon SP-API isn't configured yet. ${desc.errorMessage} ` +
				`Once the SPAPI_* vars are filled in (see samdoctor-web/.env.example) ` +
				`and the dev server restarted, try Connect again.`
		);
	}

	try {
		await pruneExpiredOauthStates();
		const state = await createOauthState({ storeId, userId: locals.user.id });
		throw redirect(303, buildConsentUrl(state));
	} catch (e) {
		// SvelteKit's redirect() throws a Response — let it propagate.
		if (e instanceof Response) throw e;
		// Same for `error()` from @sveltejs/kit (HttpError-like objects).
		if (e && typeof e === 'object' && 'status' in (e as Record<string, unknown>)) throw e;

		const desc = describeError(e);
		await logError({
			source: 'spapi.connect',
			operation: 'initiate',
			userId: locals.user.id,
			accountId: row.account_id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { storeId }
		});
		throw error(500, `Could not start SP-API connection: ${desc.errorMessage}`);
	}
};
