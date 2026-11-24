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

const MAX_BODY = 256 * 1024;
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
		principal = await requireIntegrationPermission(event.request, null, { clientIp: ip });
	} catch (e) {
		if (e instanceof ApiError) {
			const h: Record<string, string> = { ...headers };
			if (e.status === 401) h['www-authenticate'] = 'Bearer';
			if (e.retryAfterSeconds) h['retry-after'] = String(e.retryAfterSeconds);
			return json(rpcError(null, -32001, e.message), { status: e.status, headers: h });
		}
		throw e;
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

	const audit: { tool?: string; permission?: string } = {};
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

	// Audit tool calls (and only identifiers, never arguments' free text or results).
	if (msg.method === 'tools/call') {
		await recordIntegrationEvent({
			integrationId: principal.integrationId, integrationName: principal.integrationName, credentialId: principal.credentialId,
			accountId: principal.accountId, defaultUserId: principal.defaultUserId, requiredPermission: audit.permission ?? null,
			operation: `mcp.${audit.tool ?? 'unknown'}`, resourceType: 'mcp_tool', outcome, httpStatus: 200, requestId, sourceIp: ip, durationMs: Date.now() - started
		});
	}
	if (res === null) return new Response(null, { status: 202, headers });
	return json(res, { headers });
};
