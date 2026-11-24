/**
 * OAuth 2.1 authorization server for the MCP connector (AD-1969).
 *
 * - Public clients only (dynamic registration, no secret); PKCE (S256) is mandatory.
 * - Authorization codes: 60 s, single use (re-use revokes the grant and raises an alert).
 * - Access tokens: 15 min, valid ONLY at /mcp. Refresh tokens: 30 days, rotated on every use;
 *   presenting a rotated one revokes the whole grant and raises an alert.
 * - Only SHA-256 hashes are stored. Each grant is backed by a hidden integration_clients row so the existing
 *   pause/disable, rate-limit, idempotency and audit machinery applies unchanged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../db';
import type { IntegrationPermission } from '../integrations/permissions';
import { raiseAlert } from '../security/alerts';
import { mcpAvailable } from '../mcp/killswitch';

export class OAuthError extends Error {
	constructor(readonly code: string, message: string, readonly status = 400) { super(message); }
}

export const ACCESS_TTL_SECONDS = 15 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 3600;
export const CODE_TTL_SECONDS = 60;

export const SCOPES = {
	read: { label: 'View your stores, cases, messages and required documents', permissions: ['stores.list', 'stores.read', 'cases.list', 'cases.read', 'messages.list', 'files.requirements.read'] },
	'messages:write': { label: 'Post messages on your cases', permissions: ['messages.create'] },
	'files:write': { label: 'Upload documents to your cases and stores', permissions: ['files.upload'] }
} as const satisfies Record<string, { label: string; permissions: IntegrationPermission[] }>;
export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/** Valid, de-duplicated scopes; `read` is always included. Unknown scopes are dropped. */
export function parseScopes(raw: string | null | undefined): Scope[] {
	const out = new Set<Scope>(['read']);
	for (const s of (raw ?? '').split(/[\s,]+/)) if ((ALL_SCOPES as string[]).includes(s)) out.add(s as Scope);
	return ALL_SCOPES.filter((s) => out.has(s));
}
export const scopesToPermissions = (scopes: string[]): IntegrationPermission[] =>
	[...new Set(scopes.flatMap((s) => (SCOPES as Record<string, { permissions: readonly IntegrationPermission[] }>)[s]?.permissions ?? []))];

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
export const randomToken = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;
export const ACCESS_PREFIX = 'adat_';
export const REFRESH_PREFIX = 'adrt_';

/** PKCE S256: base64url(sha256(verifier)) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
	if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
	return createHash('sha256').update(verifier).digest('base64url') === challenge;
}
export const validChallenge = (c: string) => /^[A-Za-z0-9_-]{43}$/.test(c);

// ── Clients ────────────────────────────────────────────────────────────────

/** https only; http is allowed solely for loopback (native/desktop clients). No fragments, no credentials. */
export function validRedirectUri(uri: string): boolean {
	if (typeof uri !== 'string' || uri.length > 2048) return false;
	let u: URL;
	try { u = new URL(uri); } catch { return false; }
	if (u.hash || u.username || u.password) return false;
	if (u.protocol === 'https:') return true;
	return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
}

export interface OAuthClient { client_id: string; client_name: string; redirect_uris: string[] }

export async function registerClient(name: unknown, redirectUris: unknown): Promise<OAuthClient> {
	const clientName = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : 'MCP client';
	if (!Array.isArray(redirectUris) || redirectUris.length < 1 || redirectUris.length > 5 || !redirectUris.every(validRedirectUri)) {
		throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be 1-5 https URLs (http only for localhost).');
	}
	const clientId = `adc_${randomBytes(18).toString('base64url')}`;
	const uris = [...new Set(redirectUris as string[])];
	await sql`INSERT INTO oauth_clients (client_id, client_name, redirect_uris) VALUES (${clientId}, ${clientName}, ${uris})`;
	return { client_id: clientId, client_name: clientName, redirect_uris: uris };
}

export async function getClient(clientId: string): Promise<OAuthClient | null> {
	if (!/^adc_[A-Za-z0-9_-]{20,40}$/.test(clientId)) return null;
	const [c] = await sql<OAuthClient[]>`SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = ${clientId}`;
	return c ?? null;
}

// ── Grants (connections) ───────────────────────────────────────────────────

export async function createGrant(p: { client: OAuthClient; userId: string; accountId: string; scopes: Scope[] }): Promise<string> {
	return sql.begin(async (tx) => {
		const [g] = await tx<{ id: string }[]>`
			INSERT INTO oauth_grants (client_id, client_name, user_id, account_id, scopes)
			VALUES (${p.client.client_id}, ${p.client.client_name}, ${p.userId}, ${p.accountId}, ${p.scopes}) RETURNING id`;
		const name = `${p.client.client_name} (sign-in ${g.id.slice(0, 8)})`;
		const [i] = await tx<{ id: string }[]>`
			INSERT INTO integration_clients (account_id, name, description, default_user_id, permissions, rate_limit_per_minute, oauth_grant_id)
			VALUES (${p.accountId}, ${name}, 'Created automatically when a user connected an AI assistant (OAuth).', ${p.userId},
			        ${scopesToPermissions(p.scopes)}, 60, ${g.id}) RETURNING id`;
		await tx`UPDATE oauth_grants SET integration_client_id = ${i.id} WHERE id = ${g.id}`;
		return g.id;
	});
}

export async function createAuthCode(p: { grantId: string; redirectUri: string; codeChallenge: string; resource: string | null }): Promise<string> {
	const code = randomToken('adac_');
	await sql`INSERT INTO oauth_auth_codes (code_hash, grant_id, redirect_uri, code_challenge, resource, expires_at)
	          VALUES (${sha256(code)}, ${p.grantId}, ${p.redirectUri}, ${p.codeChallenge}, ${p.resource}, now() + (${CODE_TTL_SECONDS} * interval '1 second'))`;
	return code;
}

export interface TokenResponse { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string }

async function issueTokens(grantId: string, accountId: string, scopes: string[]): Promise<TokenResponse> {
	// Kill switch: no new tokens while the connector is off for this account (or globally).
	if (!(await mcpAvailable(accountId)).ok) throw new OAuthError('access_denied', 'The AI connector is currently disabled for this account.', 403);
	const access = randomToken(ACCESS_PREFIX), refresh = randomToken(REFRESH_PREFIX);
	await sql`
		INSERT INTO oauth_tokens (grant_id, kind, token_hash, expires_at) VALUES
		  (${grantId}, 'access', ${sha256(access)}, now() + (${ACCESS_TTL_SECONDS} * interval '1 second')),
		  (${grantId}, 'refresh', ${sha256(refresh)}, now() + (${REFRESH_TTL_SECONDS} * interval '1 second'))`;
	return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: scopes.join(' ') };
}

interface GrantRow { id: string; client_id: string; account_id: string; scopes: string[]; revoked_at: Date | null }

export async function exchangeCode(p: { code: string; clientId: string; redirectUri: string; verifier: string; resource: string | null }): Promise<TokenResponse> {
	const [row] = await sql<{ grant_id: string; redirect_uri: string; code_challenge: string; resource: string | null; expires_at: Date; used_at: Date | null }[]>`
		SELECT grant_id, redirect_uri, code_challenge, resource, expires_at, used_at FROM oauth_auth_codes WHERE code_hash = ${sha256(p.code)}`;
	if (!row) throw new OAuthError('invalid_grant', 'Invalid authorization code.');
	const [g] = await sql<GrantRow[]>`SELECT id, client_id, account_id, scopes, revoked_at FROM oauth_grants WHERE id = ${row.grant_id}`;
	if (!g || g.client_id !== p.clientId) throw new OAuthError('invalid_grant', 'Invalid authorization code.');
	if (row.used_at) {
		await revokeGrant(g.id, 'authorization code reused');
		await raiseAlert({ kind: 'oauth_code_reuse', severity: 'high', accountId: g.account_id, subjectType: 'oauth_grant', subjectId: g.id, message: 'An OAuth authorization code was used twice; the connection was revoked.' });
		throw new OAuthError('invalid_grant', 'Authorization code already used.');
	}
	if (g.revoked_at || row.expires_at.getTime() <= Date.now()) throw new OAuthError('invalid_grant', 'Authorization code expired.');
	if (row.redirect_uri !== p.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match.');
	if (!pkceMatches(p.verifier, row.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed.');
	if (row.resource && p.resource && row.resource !== p.resource) throw new OAuthError('invalid_target', 'resource does not match.');
	// Atomic single use: only one concurrent exchange can win.
	const claimed = await sql<{ code_hash: string }[]>`UPDATE oauth_auth_codes SET used_at = now() WHERE code_hash = ${sha256(p.code)} AND used_at IS NULL RETURNING code_hash`;
	if (!claimed[0]) throw new OAuthError('invalid_grant', 'Authorization code already used.');
	return issueTokens(g.id, g.account_id, g.scopes);
}

export async function refreshTokens(p: { refreshToken: string; clientId: string }): Promise<TokenResponse> {
	const [t] = await sql<{ id: string; grant_id: string; expires_at: Date; used_at: Date | null; revoked_at: Date | null }[]>`
		SELECT id, grant_id, expires_at, used_at, revoked_at FROM oauth_tokens WHERE token_hash = ${sha256(p.refreshToken)} AND kind = 'refresh'`;
	if (!t) throw new OAuthError('invalid_grant', 'Invalid refresh token.');
	const [g] = await sql<GrantRow[]>`SELECT id, client_id, account_id, scopes, revoked_at FROM oauth_grants WHERE id = ${t.grant_id}`;
	if (!g || g.client_id !== p.clientId || g.revoked_at || t.revoked_at) throw new OAuthError('invalid_grant', 'Invalid refresh token.');
	if (t.used_at) {
		await revokeGrant(g.id, 'refresh token reused');
		await raiseAlert({ kind: 'oauth_refresh_reuse', severity: 'high', accountId: g.account_id, subjectType: 'oauth_grant', subjectId: g.id, message: 'A rotated OAuth refresh token was presented again (possible theft); the connection was revoked.' });
		throw new OAuthError('invalid_grant', 'Refresh token already used.');
	}
	if (t.expires_at.getTime() <= Date.now()) throw new OAuthError('invalid_grant', 'Refresh token expired.');
	const claimed = await sql<{ id: string }[]>`UPDATE oauth_tokens SET used_at = now() WHERE id = ${t.id} AND used_at IS NULL RETURNING id`;
	if (!claimed[0]) throw new OAuthError('invalid_grant', 'Refresh token already used.');
	return issueTokens(g.id, g.account_id, g.scopes);
}

// ── Revocation ─────────────────────────────────────────────────────────────

/** Revoke a grant: all its tokens die and its hidden integration is disabled. Idempotent. */
export async function revokeGrant(grantId: string, reason: string): Promise<void> {
	await sql.begin(async (tx) => {
		const [g] = await tx<{ integration_client_id: string | null }[]>`
			UPDATE oauth_grants SET revoked_at = coalesce(revoked_at, now()), revoked_reason = coalesce(revoked_reason, ${reason})
			WHERE id = ${grantId} RETURNING integration_client_id`;
		await tx`UPDATE oauth_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE grant_id = ${grantId}`;
		if (g?.integration_client_id) {
			await tx`UPDATE integration_clients SET status = 'disabled', disabled_at = coalesce(disabled_at, now()), disable_reason = coalesce(disable_reason, ${reason})
			         WHERE id = ${g.integration_client_id}`;
		}
	});
}

/** RFC 7009: unknown tokens are not an error. */
export async function revokeByToken(raw: string): Promise<void> {
	const [t] = await sql<{ grant_id: string }[]>`SELECT grant_id FROM oauth_tokens WHERE token_hash = ${sha256(raw)}`;
	if (t) await revokeGrant(t.grant_id, 'revoked by client');
}

export interface GrantView { id: string; client_name: string; user_email: string; scopes: string[]; created_at: Date; last_used_at: Date | null; revoked_at: Date | null }

export function listGrants(accountId: string, onlyUserId: string | null = null): Promise<GrantView[]> {
	return sql<GrantView[]>`
		SELECT g.id, g.client_name, u.email AS user_email, g.scopes, g.created_at, g.last_used_at, g.revoked_at
		FROM oauth_grants g JOIN users u ON u.id = g.user_id
		WHERE g.account_id = ${accountId} AND ${onlyUserId ? sql`g.user_id = ${onlyUserId}` : sql`true`}
		ORDER BY g.revoked_at IS NOT NULL, g.created_at DESC LIMIT 100`;
}

/** Revoke a grant only if it belongs to this account (and, when given, this user). */
export async function revokeGrantForAccount(grantId: string, accountId: string, userId: string | null, reason: string): Promise<boolean> {
	const [g] = await sql<{ id: string }[]>`SELECT id FROM oauth_grants WHERE id = ${grantId} AND account_id = ${accountId} AND ${userId ? sql`user_id = ${userId}` : sql`true`}`;
	if (!g) return false;
	await revokeGrant(g.id, reason);
	return true;
}

export async function revokeAllGrants(scope: { accountId?: string }, reason: string): Promise<number> {
	const rows = await sql<{ id: string }[]>`SELECT id FROM oauth_grants WHERE revoked_at IS NULL AND ${scope.accountId ? sql`account_id = ${scope.accountId}` : sql`true`}`;
	for (const r of rows) await revokeGrant(r.id, reason);
	return rows.length;
}
