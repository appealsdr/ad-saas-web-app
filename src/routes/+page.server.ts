import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * Site root.
 *
 * Normally just bounces to the dashboard. BUT Amazon SP-API redirects the
 * OAuth result to the app's *registered* redirect URI — which, depending on
 * how the app is configured in Seller Central (and when tunnelling through
 * ngrok), is often the bare domain root rather than /auth/spapi/callback:
 *
 *   https://<host>/?spapi_oauth_code=...&state=...&selling_partner_id=...
 *
 * When that happens the params land here and the real handler never runs, so
 * the store is never marked connected and the tokens are never stored. Detect
 * those params and forward (303, preserving the query string) to the callback
 * so the connection completes regardless of which URI Amazon redirected to.
 */
export const load: PageServerLoad = async ({ url }) => {
	const p = url.searchParams;
	const looksLikeSpapiCallback =
		p.has('spapi_oauth_code') ||
		p.has('selling_partner_id') ||
		// Amazon-side denial / error still carries our CSRF state.
		((p.has('error') || p.has('error_description')) && p.has('state'));

	if (looksLikeSpapiCallback) {
		throw redirect(303, `/auth/spapi/callback${url.search}`);
	}

	throw redirect(303, '/dashboard');
};
