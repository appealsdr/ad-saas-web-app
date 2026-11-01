/**
 * Bearer API keys for server-to-server callers (Salesforce Flows/Apex hitting
 * our /api/sfdc/* endpoints).
 *
 * Same shape as auth/session.ts: a random raw key is handed out once, only
 * its SHA-256 hash is stored, and lookup re-hashes the incoming value. A DB
 * leak can't be replayed as a valid key.
 *
 * Issuing a key is an ops action (run issueApiKey() from a one-off script or
 * a future admin route) — there is no public "create API key" endpoint.
 */
import { createHash, randomBytes } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { sql } from '../db';

export type ApiScope = 'provision' | 'reset_password';

export interface ApiKeyPrincipal {
	id: string;
	label: string;
	scopes: ApiScope[];
}

function hashKey(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

/** Generate + persist a new API key. Returns the raw key — shown once, never stored. */
export async function issueApiKey(
	label: string,
	scopes: ApiScope[],
	expiresAt: Date | null = null
): Promise<{ id: string; rawKey: string }> {
	const rawKey = `sfdc_${randomBytes(32).toString('base64url')}`;
	const [row] = await sql<{ id: string }[]>`
		INSERT INTO api_keys (label, key_hash, scopes, expires_at)
		VALUES (${label}, ${hashKey(rawKey)}, ${scopes}, ${expiresAt})
		RETURNING id
	`;
	return { id: row.id, rawKey };
}

function extractBearerToken(request: Request): string | null {
	const header = request.headers.get('authorization') ?? '';
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : null;
}

/**
 * Require a valid, non-revoked, non-expired API key with the given scope.
 * Throws a SvelteKit `error()` (401/403) on failure — call from +server.ts
 * request handlers, no try/catch needed at the call site.
 */
export async function requireApiKey(request: Request, scope: ApiScope): Promise<ApiKeyPrincipal> {
	const rawKey = extractBearerToken(request);
	if (!rawKey) throw error(401, 'Missing bearer token.');

	const keyHash = hashKey(rawKey);
	const rows = await sql<
		{ id: string; label: string; scopes: string[]; expires_at: Date | null; revoked_at: Date | null }[]
	>`
		SELECT id, label, scopes, expires_at, revoked_at
		FROM api_keys
		WHERE key_hash = ${keyHash}
		LIMIT 1
	`;
	const row = rows[0];

	if (!row) throw error(401, 'Invalid API key.');
	if (row.revoked_at) throw error(401, 'This API key has been revoked.');
	if (row.expires_at && row.expires_at.getTime() <= Date.now()) {
		throw error(401, 'This API key has expired.');
	}
	if (!row.scopes.includes(scope)) throw error(403, `API key is missing the "${scope}" scope.`);

	// Best-effort, non-blocking — a failed touch shouldn't fail the request.
	sql`UPDATE api_keys SET last_used_at = now() WHERE id = ${row.id}`.catch(() => {});

	return { id: row.id, label: row.label, scopes: row.scopes as ApiScope[] };
}
