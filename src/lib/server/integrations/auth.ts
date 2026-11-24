/**
 * Authentication + authorization for the multi-integration public API (AD-1966).
 *
 * A bearer credential identifies exactly ONE integration. The integration (never
 * a request-supplied id) determines the account boundary, permission profile,
 * default user, rate limit and audit identity. Permissions of different
 * integrations on the same account are never combined.
 *
 * Separate from auth/api_key.ts (Salesforce provisioning keys), which is unchanged.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../db';
import { hitRateLimit } from '../admin/rate_limit';
import { ApiError } from './errors';
import { ipAllowed } from './ip';
import { isIntegrationPermission, type IntegrationPermission } from './permissions';

export type IntegrationStatus = 'active' | 'paused' | 'disabled';

export interface IntegrationPrincipal {
	integrationId: string;
	integrationName: string;
	accountId: string;
	credentialId: string;
	defaultUserId: string;
	status: IntegrationStatus;
	permissions: IntegrationPermission[];
	allowedIpRanges: string[];
	rateLimitPerMinute: number;
}

export const CREDENTIAL_PREFIX = 'adi_';

export function hashCredential(raw: string): string {
	return createHash('sha256').update(raw).digest('hex');
}

/** New raw credential + its non-secret display prefix. The raw value is never stored. */
export function generateCredential(): { rawKey: string; keyPrefix: string; keyHash: string } {
	const rawKey = `${CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
	return { rawKey, keyPrefix: rawKey.slice(0, 12), keyHash: hashCredential(rawKey) };
}

export function extractBearerToken(request: Request): string | null {
	const header = request.headers.get('authorization') ?? '';
	const match = /^Bearer\s+(.+)$/i.exec(header.trim());
	return match ? match[1].trim() : null;
}

/** Rate-limit key: isolated per integration and per one-minute window. */
export function rateLimitKey(integrationId: string, now = Date.now()): string {
	return `api-integration:${integrationId}:${Math.floor(now / 60_000)}`;
}

interface Row {
	credential_id: string;
	expires_at: Date | null;
	revoked_at: Date | null;
	integration_id: string;
	name: string;
	account_id: string;
	default_user_id: string;
	status: IntegrationStatus;
	permissions: string[];
	allowed_ip_ranges: string[] | null;
	rate_limit_per_minute: number;
}

export interface RequireOptions {
	/** Source IP as reported by the platform (event.getClientAddress()). Needed for IP allowlists. */
	clientIp?: string | null;
	/** Accept OAuth access tokens (adat_…). Only /mcp sets this — OAuth tokens are bound to that audience. */
	allowOAuth?: boolean;
}

/**
 * Processing order (each step fails closed):
 *  1 extract bearer · 2 resolve credential · 3 resolve its exact integration ·
 *  4 credential not revoked/expired · 5 integration active · 6 source IP ·
 *  7 integration rate limit · 8 exact required permission ·
 *  9 account + default user valid. Resource-level tenant checks come after.
 */
export async function requireIntegrationPermission(
	request: Request,
	/** `null` = authenticate only (no permission check) — used by MCP initialize/tools/list, which filter by permission instead. */
	requiredPermission: IntegrationPermission | null,
	opts: RequireOptions = {}
): Promise<IntegrationPrincipal> {
	// 1
	const raw = extractBearerToken(request);
	if (!raw) throw new ApiError(401, 'INVALID_CREDENTIAL', 'Missing or invalid bearer credential.');

	// 2 + 3 — one lookup: credential → exactly one integration.
	const isOAuth = raw.startsWith('adat_');
	if (isOAuth && !opts.allowOAuth) throw new ApiError(401, 'INVALID_CREDENTIAL', 'Missing or invalid bearer credential.');
	const rows = isOAuth ? await sql<Row[]>`
		SELECT t.id AS credential_id, t.expires_at, coalesce(t.revoked_at, g.revoked_at) AS revoked_at,
		       i.id AS integration_id, i.name, i.account_id, i.default_user_id, i.status,
		       i.permissions, i.allowed_ip_ranges::text[] AS allowed_ip_ranges, i.rate_limit_per_minute
		FROM oauth_tokens t
		JOIN oauth_grants g ON g.id = t.grant_id
		JOIN integration_clients i ON i.id = g.integration_client_id
		WHERE t.token_hash = ${hashCredential(raw)} AND t.kind = 'access'
		LIMIT 1
	` : await sql<Row[]>`
		SELECT c.id AS credential_id, c.expires_at, c.revoked_at,
		       i.id AS integration_id, i.name, i.account_id, i.default_user_id, i.status,
		       i.permissions, i.allowed_ip_ranges::text[] AS allowed_ip_ranges, i.rate_limit_per_minute
		FROM integration_credentials c
		JOIN integration_clients i ON i.id = c.integration_client_id
		WHERE c.key_hash = ${hashCredential(raw)}
		LIMIT 1
	`;
	const row = rows[0];
	// Unknown / revoked / expired all look identical to the caller.
	if (!row) throw new ApiError(401, 'INVALID_CREDENTIAL', 'Missing or invalid bearer credential.');

	const principal: IntegrationPrincipal = {
		integrationId: row.integration_id,
		integrationName: row.name,
		accountId: row.account_id,
		credentialId: row.credential_id,
		defaultUserId: row.default_user_id,
		status: row.status,
		permissions: row.permissions.filter(isIntegrationPermission),
		allowedIpRanges: row.allowed_ip_ranges ?? [],
		rateLimitPerMinute: row.rate_limit_per_minute
	};
	const fail = (status: number, code: string, message: string, extra?: Partial<ApiError>) => {
		const e = new ApiError(status, code, message);
		e.principal = principal;
		e.requiredPermission = requiredPermission ?? undefined;
		Object.assign(e, extra);
		return e;
	};

	// 4
	if (row.revoked_at || (row.expires_at && row.expires_at.getTime() <= Date.now())) {
		throw fail(401, 'INVALID_CREDENTIAL', 'Missing or invalid bearer credential.');
	}
	// 5
	if (row.status === 'paused') throw fail(503, 'INTEGRATION_PAUSED', 'This integration is paused.');
	if (row.status === 'disabled') throw fail(401, 'INTEGRATION_DISABLED', 'This integration is disabled.');

	// 6
	if (!ipAllowed(principal.allowedIpRanges, opts.clientIp)) {
		throw fail(403, 'IP_NOT_ALLOWED', 'Requests from this IP address are not allowed.');
	}

	// Best-effort credential usage metadata (does not fail the request).
	if (isOAuth) {
		sql`UPDATE oauth_grants SET last_used_at = now() WHERE id = (SELECT grant_id FROM oauth_tokens WHERE id = ${row.credential_id})`.catch(() => {});
	} else {
		sql`UPDATE integration_credentials
		    SET last_used_at = now(), last_used_ip = ${validInet(opts.clientIp)}
		    WHERE id = ${row.credential_id}`.catch(() => {});
	}

	// 7 — isolated per integration (never one shared bucket per account).
	const rl = await hitRateLimit(rateLimitKey(principal.integrationId), principal.rateLimitPerMinute, 60);
	if (!rl.allowed) {
		throw fail(429, 'RATE_LIMITED', 'Rate limit exceeded for this integration.', { retryAfterSeconds: rl.retryAfterSeconds });
	}

	// 8 — exact permission from THIS integration only.
	if (requiredPermission && !principal.permissions.includes(requiredPermission)) {
		throw fail(403, 'PERMISSION_DENIED', `This integration lacks the "${requiredPermission}" permission.`);
	}

	// 9 — account and default user still valid (e.g. user moved/deactivated after a merge).
	const [ok] = await sql<{ ok: boolean }[]>`
		SELECT EXISTS (
			SELECT 1 FROM users u JOIN accounts a ON a.id = u.account_id
			WHERE u.id = ${principal.defaultUserId} AND u.account_id = ${principal.accountId}
			  AND u.is_active AND a.merged_into_account_id IS NULL
		) AS ok
	`;
	if (!ok?.ok) throw fail(409, 'INTEGRATION_MISCONFIGURED', 'The default user for this integration is no longer valid.');

	return principal;
}

function validInet(ip: string | null | undefined): string | null {
	if (!ip) return null;
	const v = ip.trim();
	return /^[0-9a-fA-F:.]+$/.test(v) ? v : null;
}
