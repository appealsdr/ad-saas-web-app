/**
 * GET /auth/spapi/callback
 *
 * Amazon redirects here after the seller approves consent. The URL carries
 * everything we need to persist the connection on the store row:
 *
 *   spapi_oauth_code      — one-time authorization code (exchanged for tokens
 *                            below; never stored at rest)
 *   selling_partner_id    — the seller's permanent Amazon ID
 *   state                 — our CSRF token (we created it in /auth/spapi)
 *   mws_auth_token        — present for sellers migrating from MWS
 *   plus any other params Amazon may add
 *
 * Flow:
 *   1. Validate `state` (atomic consume of spapi_oauth_states → user+store).
 *   2. Persist the raw query params (minus the one-time code) on the store
 *      for audit + debugging.
 *   3. Exchange the code at LWA → { access_token, refresh_token, expires_in }.
 *   4. UPDATE the store with tokens, status, and seller id.
 *   4b. Fetch GET /sellers/v1/marketplaceParticipations and store the
 *       marketplaces Amazon confirms the seller is actually active in —
 *       this is the source of truth, not whatever (if anything) the user
 *       typed when creating the store. Best-effort: a failure here doesn't
 *       fail the connection.
 *   5. Re-issue a session cookie for the verified user (the CSRF state proved
 *      they initiated, so we know who they are). This is the bit that fixes
 *      the "redirected to /login after success" symptom — the browser may have
 *      dropped the original session cookie during the cross-site OAuth chain
 *      (older strict-cookie sessions, third-party-cookie blockers, etc.).
 *   6. 303 → /auth/spapi/connected/<storeId> confirmation page.
 */
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { consumeOauthState, exchangeCodeForTokens, fetchMarketplaceParticipations } from '$lib/server/spapi';
import { marketplaceIdToCode } from '$lib/server/spapi_reports';
import { createSession } from '$lib/server/auth/session';
import { setSessionCookie } from '$lib/server/auth/cookie';
import { updateSalesforceStore } from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';

// Keys we DON'T want to persist (one-time secrets that should never sit at rest).
const REDACTED_PARAMS = new Set(['spapi_oauth_code']);

function collectCallbackParams(searchParams: URLSearchParams): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of searchParams.entries()) {
		if (REDACTED_PARAMS.has(k)) continue;
		out[k] = v;
	}
	return out;
}

export const GET: RequestHandler = async ({ url, request, cookies, getClientAddress }) => {
	const code = url.searchParams.get('spapi_oauth_code');
	const sellingPartnerId = url.searchParams.get('selling_partner_id');
	const state = url.searchParams.get('state');
	const amazonError =
		url.searchParams.get('error') || url.searchParams.get('error_description');

	if (!state) throw error(400, 'Missing state parameter.');

	const stateRow = await consumeOauthState(state);
	if (!stateRow) throw error(400, 'Invalid or expired OAuth state. Please retry.');

	// Capture everything Amazon sent so admins can audit later.
	const callbackParams = collectCallbackParams(url.searchParams);

	// Amazon-side denial or missing code → mark error, bounce to store page.
	if (amazonError || !code) {
		await sql`
			UPDATE stores
			SET spapi_status = 'error',
			    spapi_last_error = ${amazonError ?? 'Amazon did not return an auth code.'},
			    spapi_callback_params = ${sql.json(callbackParams)}
			WHERE id = ${stateRow.storeId}
		`;
		throw redirect(303, `/stores/${stateRow.storeId}?spapi=denied`);
	}

	// ── 1. Exchange code for tokens, persist everything on the store row ──
	let sfdcStoreId: string | null = null;
	let accountId: string | null = null;
	let accessToken: string | null = null;
	try {
		const tokens = await exchangeCodeForTokens(code);
		const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
		accessToken = tokens.access_token;

		// Amazon's selling_partner_id is the source of truth once connected —
		// override any manually-entered seller_id rather than only backfilling.
		const [row] = await sql<{ sfdc_store_id: string | null; account_id: string }[]>`
			UPDATE stores
			SET spapi_status = 'connected',
			    spapi_refresh_token = ${tokens.refresh_token ?? null},
			    spapi_access_token = ${tokens.access_token},
			    spapi_access_token_expires_at = ${expiresAt},
			    spapi_connected_seller_id = ${sellingPartnerId},
			    spapi_connected_at = now(),
			    spapi_last_error = NULL,
			    spapi_callback_params = ${sql.json(callbackParams)},
			    seller_id = COALESCE(${sellingPartnerId}, seller_id)
			WHERE id = ${stateRow.storeId}
			RETURNING sfdc_store_id, account_id
		`;
		sfdcStoreId = row?.sfdc_store_id ?? null;
		accountId = row?.account_id ?? null;
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'spapi.callback',
			operation: 'exchange_code',
			userId: stateRow.userId,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { storeId: stateRow.storeId, sellingPartnerId, params: callbackParams }
		});
		await sql`
			UPDATE stores
			SET spapi_status = 'error',
			    spapi_last_error = ${desc.errorMessage},
			    spapi_callback_params = ${sql.json(callbackParams)}
			WHERE id = ${stateRow.storeId}
		`;
		throw redirect(303, `/stores/${stateRow.storeId}?spapi=error`);
	}

	// ── 1a. Fetch confirmed marketplaces from Amazon (best-effort) ──
	// This is the source of truth — it overrides anything the user typed (or,
	// under the current flow, whatever was left null at store creation, since
	// marketplaces/Seller ID are no longer collected on the Create Store form).
	let marketplacesJoined: string | null = null;
	if (accessToken) {
		try {
			const participations = await fetchMarketplaceParticipations(accessToken);
			const codes = participations
				.filter((p) => p.isParticipating)
				.map((p) => marketplaceIdToCode(p.marketplaceId))
				.filter((c): c is string => !!c);
			if (codes.length) {
				marketplacesJoined = codes.join(';');
				await sql`UPDATE stores SET marketplaces = ${marketplacesJoined} WHERE id = ${stateRow.storeId}`;
			}
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'spapi.callback',
				operation: 'fetch_marketplace_participations',
				severity: 'warn',
				userId: stateRow.userId,
				accountId: accountId ?? undefined,
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { storeId: stateRow.storeId }
			});
		}
	}

	// ── 1b. Push the confirmed seller_id + marketplaces to Salesforce (best-effort) ──
	// Amazon's selling_partner_id overrides whatever Seller_ID__c held before.
	if (sfdcStoreId && (sellingPartnerId || marketplacesJoined)) {
		const sfResult = await updateSalesforceStore(
			sfdcStoreId,
			{
				...(sellingPartnerId ? { sellerId: sellingPartnerId } : {}),
				...(marketplacesJoined ? { marketplaces: marketplacesJoined } : {})
			},
			{ userId: stateRow.userId, accountId: accountId ?? undefined, localStoreId: stateRow.storeId }
		);
		if (!sfResult.ok) {
			await logError({
				source: 'spapi.callback',
				operation: 'update_sfdc_seller_id',
				severity: 'warn',
				userId: stateRow.userId,
				accountId: accountId ?? undefined,
				errorMessage: sfResult.error,
				errorCode: sfResult.errorCode,
				context: { storeId: stateRow.storeId, sfdcStoreId, sellingPartnerId, marketplacesJoined }
			});
		}
	}

	// ── 2. Re-issue a session for the verified user ──
	// The CSRF state row was created in /auth/spapi by an authenticated user,
	// then atomically consumed above. We KNOW stateRow.userId initiated this
	// flow — so we can safely create a fresh session and set the cookie,
	// guaranteeing the confirmation page is reachable even if the browser
	// dropped the original session cookie during the Amazon redirect chain.
	try {
		const { rawToken } = await createSession(stateRow.userId, {
			ipAddress: getClientAddress(),
			userAgent: request.headers.get('user-agent') ?? undefined
		});
		setSessionCookie(cookies, { url }, rawToken);
	} catch (e) {
		// Non-fatal — the original cookie may still work; just log and continue.
		const desc = describeError(e);
		await logError({
			source: 'spapi.callback',
			operation: 'reissue_session',
			severity: 'warn',
			userId: stateRow.userId,
			errorMessage: desc.errorMessage,
			stack: desc.stack
		});
	}

	throw redirect(303, `/auth/spapi/connected/${stateRow.storeId}`);
};
