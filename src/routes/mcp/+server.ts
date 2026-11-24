/**
 * POST /mcp — MCP endpoint (Streamable HTTP, stateless). AD-1969.
 * Auth: the same integration bearer key as /api/v1 (IP allowlist, rate limit, status, per-tool permissions, audit all apply).
 * Hardening: browser Origins are rejected unless allow-listed (DNS-rebinding guard), small body cap, no SSE/GET stream.
 */
import { json, type RequestHandler } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { requireIntegrationPermission, type IntegrationPrincipal } from '$lib/server/integrations/auth';
import { recordIntegrationEvent } from '$lib/server/integrations/audit';
import { ApiError } from '$lib/server/integrations/errors';
import { clientIp } from '$lib/server/integrations/http';
import { handleRpc, isRpcRequest, rpcError } from '$lib/server/mcp/protocol';
import { logError, describeError } from '$lib/server/error_log';
import { mcpAvailable } from '$lib/server/mcp/killswitch';
import { hitRateLimit } from '$lib/server/admin/rate_limit';
import { raiseAlert } from '$lib/server/security/alerts';
import { publicOrigin } from '$lib/server/oauth/meta';

// Room for a 5 MB file as base64 inside one JSON message (see MCP_MAX_FILE_BYTES).
const MAX_BODY = 8 * 1024 * 1024;
const headers = { 'cache-control': 'no-store' };

const allowedOrigins = () => (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim()).filter(Boolean);

export const GET: RequestHandler = () => new Response('Method not allowed', { status: 405, headers: { ...headers, allow: 'POST' } });
export const DELETE = GET;

export const POST: RequestHandler = async (event) => {
	const requestId = event.locals.requestId ?? randomUUID();
	const started = Date.now();
	const origin = event.request.headers.get('origin');
	if (origin && !allowedOrigins().includes(origin)) return json({ error: 'Origin not allowed.' }, { status: 403, headers });

	const ip = clientIp(event);
	let principal: IntegrationPrincipal;
	try {
		principal = await requireIntegrationPermission(event.request, null, { clientIp: ip, allowOAuth: true });
	} catch (e) {
		if (e instanceof ApiError) {
			const h: Record<string, string> = { ...headers };
			// MCP clients discover the OAuth server from this header (RFC 9728).
			if (e.status === 401) h['www-authenticate'] = `Bearer resource_metadata="${publicOrigin(event.url.origin)}/.well-known/oauth-protected-resource/mcp"`;
			if (e.retryAfterSeconds) h['retry-after'] = String(e.retryAfterSeconds);
			return json(rpcError(null, -32001, e.message), { status: e.status, headers: h });
		}
		throw e;
	}

	// Kill switch (global, then per account). Checked after auth so we never reveal state to anonymous callers.
	const avail = await mcpAvailable(principal.accountId);
	if (!avail.ok) {
		return json(rpcError(null, -32002, avail.reason === 'global' ? 'The AI connector is temporarily disabled.' : 'The AI connector is not enabled for this account.'), { status: 503, headers: { ...headers, 'retry-after': '300' } });
	}

	let msg: unknown;
	const len = Number(event.request.headers.get('content-length') ?? 0);
	try {
		if (len > MAX_BODY) return json(rpcError(null, -32600, 'Request too large.'), { status: 413, headers });
		const text = await event.request.text();
		if (text.length > MAX_BODY) return json(rpcError(null, -32600, 'Request too large.'), { status: 413, headers });
		msg = JSON.parse(text);
	} catch {
		return json(rpcError(null, -32700, 'Parse error.'), { status: 400, headers });
	}
	if (!isRpcRequest(msg)) return json(rpcError(null, -32600, 'Invalid request (send one JSON-RPC message).'), { status: 400, headers });

	const audit: { tool?: string; permission?: string; errorCode?: string } = {};
	let outcome = 'success';
	let res: object | null;
	try {
		res = await handleRpc(msg, principal, audit);
		const r = res as { error?: unknown; result?: { isError?: boolean } } | null;
		if (r?.error || r?.result?.isError) outcome = 'error';
	} catch (e) {
		outcome = 'error';
		const d = describeError(e);
		await logError({ source: 'mcp', operation: audit.tool ?? msg.method, accountId: principal.accountId, errorMessage: d.errorMessage, stack: d.stack, context: { integrationId: principal.integrationId, requestId } }).catch(() => {});
		res = rpcError(msg.id, -32603, 'Internal error.');
	}

	// Abuse signals → alerts (best effort, de-duplicated).
	if (msg.method === 'tools/call') await watchForAbuse(principal, audit);

	// Audit tool calls (and only identifiers, never arguments' free text or results).
	if (msg.method === 'tools/call') {
		await recordIntegrationEvent({
			integrationId: principal.integrationId, integrationName: principal.integrationName, credentialId: principal.credentialId,
			accountId: principal.accountId, defaultUserId: principal.defaultUserId, requiredPermission: audit.permission ?? null,
			operation: `mcp.${audit.tool ?? 'unknown'}`, resourceType: 'mcp_tool', outcome, errorCode: audit.errorCode ?? null, httpStatus: 200, requestId, sourceIp: ip, durationMs: Date.now() - started
		});
	}
	if (res === null) return new Response(null, { status: 202, headers });
	return json(res, { headers });
};

const DENIAL_CODES = new Set(['PERMISSION_DENIED', 'NOT_FOUND']);

/** Repeated denials / not-founds (probing) and unusual call volume raise a security alert for the connection. */
async function watchForAbuse(p: IntegrationPrincipal, audit: { errorCode?: string }): Promise<void> {
	try {
		const base = { accountId: p.accountId, subjectType: 'integration', subjectId: p.integrationId };
		if (audit.errorCode && DENIAL_CODES.has(audit.errorCode)) {
			const r = await hitRateLimit(`mcp-deny:${p.integrationId}`, 20, 600);
			if (!r.allowed && r.count === 21) {
				await raiseAlert({ ...base, kind: 'mcp_repeated_denials', severity: 'medium', message: `"${p.integrationName}" had more than 20 denied/not-found tool calls in 10 minutes (possible probing).` });
			}
		}
		const v = await hitRateLimit(`mcp-vol:${p.integrationId}`, 600, 3600);
		if (!v.allowed && v.count === 601) {
			await raiseAlert({ ...base, kind: 'mcp_high_volume', severity: 'medium', dedupeSeconds: 3600, message: `"${p.integrationName}" made more than 600 tool calls in one hour.` });
		}
	} catch { /* alerting must never break the request */ }
}
