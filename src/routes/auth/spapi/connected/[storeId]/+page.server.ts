/**
 * SP-API connection confirmation page.
 *
 * Loaded after a successful redirect from /auth/spapi/callback. Reads the
 * store row (which the callback just updated with refresh + access tokens)
 * and renders a confirmation UI.
 *
 *  - Tenancy: store must belong to the signed-in user's account.
 *  - If the store isn't actually connected (someone visited the URL directly
 *    after a failed flow), 303 back to the store page with the existing
 *    error banner mechanism — keeps the success page "successful" only.
 */
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';

interface StoreRow {
	id: string;
	name: string;
	marketplaces: string | null;
	country: string | null;
	seller_id: string | null;
	sfdc_store_id: string | null;
	spapi_status: string;
	spapi_connected_at: Date | null;
	spapi_connected_seller_id: string | null;
	spapi_access_token_expires_at: Date | null;
	spapi_last_error: string | null;
	spapi_callback_params: Record<string, string> | null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const rows = await sql<StoreRow[]>`
		SELECT s.id, s.name, s.marketplaces, s.country, s.seller_id,
		       s.sfdc_store_id, s.spapi_status, s.spapi_connected_at,
		       s.spapi_connected_seller_id, s.spapi_access_token_expires_at,
		       s.spapi_last_error, s.spapi_callback_params
		FROM stores s JOIN users u ON u.id = ${locals.user.id}
		WHERE s.id = ${params.storeId} AND s.account_id = u.account_id
		LIMIT 1
	`;
	const store = rows[0];
	if (!store) throw error(404, 'Store not found.');

	// Direct visit (or replay after expiry): redirect to the store page —
	// this page is meant to celebrate a fresh connection, not show staleness.
	if (store.spapi_status !== 'connected') {
		throw redirect(303, `/stores/${store.id}?spapi=${store.spapi_status === 'error' ? 'error' : 'denied'}`);
	}

	return {
		store: {
			id: store.id,
			name: store.name,
			marketplaces: store.marketplaces,
			country: store.country,
			sellerId: store.seller_id,
			sfdcStoreId: store.sfdc_store_id,
			spapiConnectedAt: store.spapi_connected_at?.toISOString() ?? null,
			spapiConnectedSellerId: store.spapi_connected_seller_id,
			spapiAccessTokenExpiresAt: store.spapi_access_token_expires_at?.toISOString() ?? null,
			// Raw URL params Amazon sent us in the callback — useful when you
			// need to debug "Amazon set up X but I don't see it" without
			// digging through error_log.
			spapiCallbackParams: store.spapi_callback_params ?? {}
		}
	};
};
