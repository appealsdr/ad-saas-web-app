/**
 * Amazon SP-API / LWA (Login with Amazon) OAuth helpers.
 *
 * Three operations:
 *   - buildConsentUrl(state) → URL we redirect the seller to for app approval
 *   - exchangeCodeForTokens(code) → POST to LWA token endpoint, get refresh + access
 *   - refreshAccessToken(refreshToken) → fresh access token from a refresh token
 *
 * Plus helpers to manage the CSRF state in `spapi_oauth_states` and to
 * lazy-refresh stored tokens for an authenticated SP-API call.
 *
 * Modeled after the amazon-spapi-auth-poc/auth.js in the same repo — same
 * flow, ported to fetch + Postgres.
 */
import { randomBytes } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { sql } from './db';

const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const STATE_TTL_MS = 10 * 60 * 1000;
const ACCESS_TOKEN_SKEW_MS = 60 * 1000;

interface SpapiConfig {
	appId: string;             // amzn1.sellerapps.app.* — consent URL
	clientId: string;          // amzn1.application-oa2-client.* — token exchange
	clientSecret: string;
	redirectUri: string;
	appVersion: string | null; // 'beta' or null
}

let cached: SpapiConfig | null = null;

export function getSpapiConfig(): SpapiConfig {
	if (cached) return cached;
	const appId = env.SPAPI_APP_ID;
	const clientId = env.SPAPI_LWA_CLIENT_ID;
	const clientSecret = env.SPAPI_LWA_CLIENT_SECRET;
	const redirectUri = env.SPAPI_REDIRECT_URI;
	const appVersion = env.SPAPI_APP_VERSION?.trim() || null;

	const missing: string[] = [];
	if (!appId) missing.push('SPAPI_APP_ID');
	if (!clientId) missing.push('SPAPI_LWA_CLIENT_ID');
	if (!clientSecret) missing.push('SPAPI_LWA_CLIENT_SECRET');
	if (!redirectUri) missing.push('SPAPI_REDIRECT_URI');
	if (missing.length) {
		throw new Error(`Missing SP-API env vars: ${missing.join(', ')}. See .env.example.`);
	}

	cached = { appId: appId!, clientId: clientId!, clientSecret: clientSecret!, redirectUri: redirectUri!, appVersion };
	return cached;
}

// ─── OAuth state (CSRF) ─────────────────────────────────────────────────

export async function createOauthState(args: {
	storeId: string;
	userId: string;
}): Promise<string> {
	const state = randomBytes(24).toString('base64url');
	const expiresAt = new Date(Date.now() + STATE_TTL_MS);
	await sql`
		INSERT INTO spapi_oauth_states (state, store_id, user_id, expires_at)
		VALUES (${state}, ${args.storeId}, ${args.userId}, ${expiresAt})
	`;
	return state;
}

export interface OauthStateRow {
	storeId: string;
	userId: string;
}

export async function consumeOauthState(state: string): Promise<OauthStateRow | null> {
	const rows = await sql<{ store_id: string; user_id: string; expires_at: Date }[]>`
		DELETE FROM spapi_oauth_states
		WHERE state = ${state}
		RETURNING store_id, user_id, expires_at
	`;
	const row = rows[0];
	if (!row) return null;
	if (row.expires_at.getTime() < Date.now()) return null;
	return { storeId: row.store_id, userId: row.user_id };
}

/** Best-effort cleanup of expired state rows. Safe to call any time. */
export async function pruneExpiredOauthStates(): Promise<void> {
	try {
		await sql`DELETE FROM spapi_oauth_states WHERE expires_at < now()`;
	} catch {
		// best-effort; never throw
	}
}

// ─── Consent URL ────────────────────────────────────────────────────────

/**
 * Build the URL to redirect the seller to. The redirect_uri is NOT in the
 * consent URL for SP-API — Amazon uses the one registered in the app settings.
 */
export function buildConsentUrl(state: string): string {
	const cfg = getSpapiConfig();
	const params = new URLSearchParams({
		application_id: cfg.appId,
		state
	});
	if (cfg.appVersion) params.set('version', cfg.appVersion);
	return `https://sellercentral.amazon.com/apps/authorize/consent?${params.toString()}`;
}

// ─── Token exchange + refresh ───────────────────────────────────────────

interface LwaTokenResponse {
	access_token: string;
	refresh_token?: string;          // present on initial exchange only
	expires_in: number;
	token_type: string;
}

export async function exchangeCodeForTokens(code: string): Promise<LwaTokenResponse> {
	const cfg = getSpapiConfig();
	const body = new URLSearchParams({
		grant_type: 'authorization_code',
		code,
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret,
		redirect_uri: cfg.redirectUri
	});
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`LWA token exchange failed (${res.status}): ${text}`);
	}
	return JSON.parse(text) as LwaTokenResponse;
}

export async function refreshAccessToken(refreshToken: string): Promise<LwaTokenResponse> {
	const cfg = getSpapiConfig();
	const body = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret
	});
	const res = await fetch(TOKEN_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`LWA refresh failed (${res.status}): ${text}`);
	}
	return JSON.parse(text) as LwaTokenResponse;
}

// ─── Store-scoped helper ────────────────────────────────────────────────

/**
 * Return a usable access token for the given store. Lazy-refreshes via the
 * stored refresh token if the cached access token is missing or stale.
 */
export async function getStoreAccessToken(storeId: string): Promise<string | null> {
	const [row] = await sql<
		{
			spapi_refresh_token: string | null;
			spapi_access_token: string | null;
			spapi_access_token_expires_at: Date | null;
		}[]
	>`
		SELECT spapi_refresh_token, spapi_access_token, spapi_access_token_expires_at
		FROM stores WHERE id = ${storeId} LIMIT 1
	`;
	if (!row?.spapi_refresh_token) return null;

	const fresh =
		row.spapi_access_token &&
		row.spapi_access_token_expires_at &&
		row.spapi_access_token_expires_at.getTime() - ACCESS_TOKEN_SKEW_MS > Date.now();
	if (fresh) return row.spapi_access_token;

	const tokens = await refreshAccessToken(row.spapi_refresh_token);
	const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);
	await sql`
		UPDATE stores
		SET spapi_access_token = ${tokens.access_token},
		    spapi_access_token_expires_at = ${expiresAt},
		    spapi_status = 'connected',
		    spapi_last_error = NULL
		WHERE id = ${storeId}
	`;
	return tokens.access_token;
}

// ─── Marketplace participations (Sellers API) ──────────────────────────
//
// The only reliable "who is this seller" data SP-API exposes post-auth —
// which marketplaces they're actually active in. Amazon does NOT expose the
// seller's storefront/display name via SP-API (no such field in this or any
// other standard-scope endpoint), so this cannot be used to "correct" a
// store's name — only its Amazon marketplace(s).
//
// buildConsentUrl() only ever sends sellers through the NA Seller Central
// authorize page, so every connected store's access token is NA-region —
// hence the hardcoded NA base URL here (see spapi_reports.ts REGION_BASE_URL
// for the full NA/EU/FE split used elsewhere for Reports).
const SELLERS_API_BASE_URL = 'https://sellingpartnerapi-na.amazon.com';

export interface MarketplaceParticipation {
	marketplaceId: string;
	name: string;
	countryCode: string;
	defaultCurrencyCode: string;
	defaultLanguageCode: string;
	domainName: string;
	isParticipating: boolean;
	hasSuspendedListings: boolean;
}

interface MarketplaceParticipationsResponse {
	payload?: {
		marketplace: {
			id: string;
			name: string;
			countryCode: string;
			defaultCurrencyCode: string;
			defaultLanguageCode: string;
			domainName: string;
		};
		participation: {
			isParticipating: boolean;
			hasSuspendedListings: boolean;
		};
	}[];
}

/** GET /sellers/v1/marketplaceParticipations — every marketplace this seller is known to Amazon in. */
export async function fetchMarketplaceParticipations(
	accessToken: string
): Promise<MarketplaceParticipation[]> {
	const res = await fetch(`${SELLERS_API_BASE_URL}/sellers/v1/marketplaceParticipations`, {
		headers: { 'x-amz-access-token': accessToken }
	});
	const text = await res.text();
	if (!res.ok) {
		throw new Error(`SP-API marketplaceParticipations failed (${res.status}): ${text}`);
	}
	const body = JSON.parse(text) as MarketplaceParticipationsResponse;
	return (body.payload ?? []).map((row) => ({
		marketplaceId: row.marketplace.id,
		name: row.marketplace.name,
		countryCode: row.marketplace.countryCode,
		defaultCurrencyCode: row.marketplace.defaultCurrencyCode,
		defaultLanguageCode: row.marketplace.defaultLanguageCode,
		domainName: row.marketplace.domainName,
		isParticipating: row.participation.isParticipating,
		hasSuspendedListings: row.participation.hasSuspendedListings
	}));
}
