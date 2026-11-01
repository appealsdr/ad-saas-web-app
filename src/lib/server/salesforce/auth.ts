/**
 * Salesforce OAuth 2.0 JWT Bearer Token Flow.
 * Docs: https://help.salesforce.com/s/articleView?id=sf.remoteaccess_oauth_jwt_flow.htm
 *
 * Flow:
 *   1. Build a signed JWT (RS256) — header.payload.signature
 *      - iss = Connected App Consumer Key
 *      - sub = Salesforce username to log in as
 *      - aud = login URL (test.salesforce.com for sandbox)
 *      - exp = now + 3 minutes (SF max)
 *   2. POST it to /services/oauth2/token as the `assertion` form field with
 *      grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer
 *   3. SF returns { access_token, instance_url, ... }
 *   4. Use that access token as a Bearer header for REST calls; refresh on 401.
 */
import { createSign } from 'node:crypto';
import { getSalesforceConfig } from './config';

export interface AccessToken {
	accessToken: string;
	instanceUrl: string;
	tokenType: string;     // "Bearer"
	scope?: string;
	issuedAt: number;      // ms epoch
	expiresAt: number;     // ms epoch — SF doesn't return exp; we assume 2h default
}

/**
 * Default Salesforce access-token lifetime when the org leaves it at the
 * Connected App default ("Immediately expire refresh token" off). SF doesn't
 * include exp in the JWT token response, so we treat 2h as the budget and
 * refresh on 401 anyway. Adjust via SFDC_TOKEN_TTL_MS if your org policy
 * forces shorter sessions.
 */
const DEFAULT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000; // refresh 1 min early

let currentToken: AccessToken | null = null;
let inflight: Promise<AccessToken> | null = null;

// ─── JWT assertion ───────────────────────────────────────────────────────

function base64url(input: Buffer | string): string {
	const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
	return buf.toString('base64url');
}

/**
 * Build and sign the JWT bearer assertion. Returns the compact JWS:
 * `<headerB64>.<payloadB64>.<signatureB64>`.
 *
 * Exported for tests; production callers go through getAccessToken().
 */
export function buildJwtAssertion(now: number = Date.now()): string {
	const cfg = getSalesforceConfig();

	const header = { alg: 'RS256', typ: 'JWT' };
	const claims = {
		iss: cfg.clientId,
		sub: cfg.username,
		aud: cfg.loginUrl,
		exp: Math.floor(now / 1000) + 180 // 3 minutes — SF max
	};

	const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;

	const signer = createSign('RSA-SHA256');
	signer.update(signingInput);
	signer.end();
	const signature = signer.sign(cfg.privateKey);

	return `${signingInput}.${base64url(signature)}`;
}

// ─── Token exchange ──────────────────────────────────────────────────────

interface SalesforceTokenResponse {
	access_token: string;
	instance_url: string;
	token_type: string;
	scope?: string;
	id?: string;
}

interface SalesforceErrorResponse {
	error: string;
	error_description?: string;
}

/**
 * Exchange a signed JWT for an access token. Always hits Salesforce — no
 * caching. Use getAccessToken() for the cached path.
 */
export async function requestAccessToken(): Promise<AccessToken> {
	const cfg = getSalesforceConfig();
	const assertion = buildJwtAssertion();

	const body = new URLSearchParams({
		grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
		assertion
	});

	const res = await fetch(`${cfg.loginUrl}/services/oauth2/token`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			Accept: 'application/json'
		},
		body
	});

	const text = await res.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error(`Salesforce token endpoint returned non-JSON (${res.status}): ${text}`);
	}

	if (!res.ok) {
		const err = parsed as SalesforceErrorResponse;
		throw new Error(
			`Salesforce JWT auth failed (${res.status} ${err.error ?? 'unknown_error'}): ${
				err.error_description ?? text
			}`
		);
	}

	const data = parsed as SalesforceTokenResponse;
	const issuedAt = Date.now();
	return {
		accessToken: data.access_token,
		instanceUrl: data.instance_url,
		tokenType: data.token_type ?? 'Bearer',
		scope: data.scope,
		issuedAt,
		expiresAt: issuedAt + DEFAULT_TOKEN_TTL_MS
	};
}

// ─── Cached access token ─────────────────────────────────────────────────

function isFresh(t: AccessToken | null): t is AccessToken {
	return !!t && t.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now();
}

/**
 * Return a usable access token, refreshing if needed. Concurrent callers
 * during a refresh share a single in-flight request (no thundering herd).
 *
 * In-memory only — for multi-instance deployments, swap this for a shared
 * cache (Redis) so all replicas reuse the same token until expiry.
 */
export async function getAccessToken(): Promise<AccessToken> {
	if (isFresh(currentToken)) return currentToken;
	if (inflight) return inflight;

	inflight = requestAccessToken()
		.then((tok) => {
			currentToken = tok;
			return tok;
		})
		.finally(() => {
			inflight = null;
		});
	return inflight;
}

/**
 * Drop the cached token. Call after a 401 from a REST API request so the
 * next call re-authenticates.
 */
export function invalidateAccessToken(): void {
	currentToken = null;
}
