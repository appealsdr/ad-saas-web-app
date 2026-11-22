/**
 * Route wrapper for /api/v1/*: authenticates via requireIntegrationPermission,
 * maps ApiError to a stable JSON error shape, and writes one audit event per
 * request against the exact integration + credential.
 */
import { json, type RequestEvent, type RequestHandler } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import { requireIntegrationPermission, type IntegrationPrincipal } from './auth';
import { recordIntegrationEvent } from './audit';
import { ApiError } from './errors';
import type { IntegrationPermission } from './permissions';
import { logError, describeError } from '../error_log';

export interface ApiContext {
	event: RequestEvent;
	request: Request;
	principal: IntegrationPrincipal;
	requestId: string;
	/** Handlers set these so the audit event names the touched resource. */
	audit: { resourceType?: string; resourceId?: string; metadata?: Record<string, unknown> };
}

export function apiJson(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}

function errorResponse(e: ApiError, requestId: string): Response {
	const headers: Record<string, string> = {};
	if (e.retryAfterSeconds) headers['retry-after'] = String(e.retryAfterSeconds);
	if (e.status === 401) headers['www-authenticate'] = 'Bearer';
	return apiJson({ error: { code: e.code, message: e.message, requestId } }, e.status, headers);
}

export function clientIp(event: RequestEvent): string | null {
	try {
		return event.getClientAddress();
	} catch {
		return null;
	}
}

export function apiRoute(
	opts: { permission: IntegrationPermission; operation: string; resourceType?: string },
	handler: (ctx: ApiContext) => Promise<Response>
): RequestHandler {
	return async (event) => {
		const started = Date.now();
		const requestId = event.locals.requestId ?? randomUUID();
		const ip = clientIp(event);
		const audit: ApiContext['audit'] = { resourceType: opts.resourceType };
		let principal: IntegrationPrincipal | undefined;
		let response: Response;
		let errorCode: string | undefined;
		let known: ApiError['principal'];

		try {
			principal = await requireIntegrationPermission(event.request, opts.permission, { clientIp: ip });
			response = await handler({ event, request: event.request, principal, requestId, audit });
		} catch (e) {
			if (e instanceof ApiError) {
				errorCode = e.code;
				known = e.principal ?? (principal as ApiError['principal']);
				response = errorResponse(e, requestId);
			} else if (isHttpError(e)) {
				errorCode = 'BAD_REQUEST';
				response = apiJson({ error: { code: errorCode, message: String(e.body?.message ?? 'Bad request.'), requestId } }, e.status);
			} else {
				errorCode = 'INTERNAL_ERROR';
				const desc = describeError(e);
				await logError({
					source: 'api.v1',
					operation: opts.operation,
					accountId: (principal ?? known)?.accountId,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: { integrationId: (principal ?? known)?.integrationId, requestId }
				}).catch(() => {});
				response = apiJson({ error: { code: errorCode, message: 'Internal error.', requestId } }, 500);
			}
		}

		const who = principal ?? known;
		if (who) {
			const status = response.status;
			await recordIntegrationEvent({
				integrationId: who.integrationId,
				integrationName: who.integrationName,
				credentialId: who.credentialId,
				accountId: who.accountId,
				defaultUserId: who.defaultUserId,
				requiredPermission: opts.permission,
				operation: opts.operation,
				resourceType: audit.resourceType ?? null,
				resourceId: audit.resourceId ?? null,
				outcome: status < 400 ? 'success' : status === 403 || status === 401 ? 'denied' : status === 429 ? 'rate_limited' : 'error',
				httpStatus: status,
				errorCode: errorCode ?? null,
				requestId,
				sourceIp: ip,
				durationMs: Date.now() - started,
				metadata: audit.metadata ?? null
			});
		}
		response.headers.set('x-request-id', requestId);
		return response;
	};
}

function isHttpError(e: unknown): e is { status: number; body?: { message?: string } } {
	return typeof e === 'object' && e !== null && 'status' in e && typeof (e as { status: unknown }).status === 'number' && 'body' in e;
}

/** Parse a JSON object body; anything else is a 400. */
export async function readJsonObject(request: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
	const len = Number(request.headers.get('content-length') ?? 0);
	if (len > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
	const text = await request.text();
	if (text.length > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		throw new ApiError(400, 'INVALID_JSON', 'Body must be valid JSON.');
	}
	if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ApiError(400, 'INVALID_JSON', 'Body must be a JSON object.');
	return v as Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SF_ID_RE = /^[a-zA-Z0-9]{15,18}$/;

export function requireUuid(v: string | undefined, what: string): string {
	if (!v || !UUID_RE.test(v)) throw new ApiError(404, 'NOT_FOUND', `${what} not found.`);
	return v.toLowerCase();
}
export function requireSfId(v: string | undefined, what: string): string {
	if (!v || !SF_ID_RE.test(v)) throw new ApiError(404, 'NOT_FOUND', `${what} not found.`);
	return v;
}

/** Optional trimmed string field with a max length; '' → null. */
export function optStr(body: Record<string, unknown>, key: string, max: number): string | null | undefined {
	if (!(key in body)) return undefined;
	const v = body[key];
	if (v === null) return null;
	if (typeof v !== 'string') throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be a string.`);
	const t = v.trim();
	if (t.length > max) throw new ApiError(422, 'VALIDATION_ERROR', `${key} must be ${max} characters or fewer.`);
	return t === '' ? null : t;
}

export function parsePaging(url: URL): { limit: number; offset: number } {
	const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '50', 10) || 50, 1), 100);
	const offset = Math.max(parseInt(url.searchParams.get('offset') ?? '0', 10) || 0, 0);
	return { limit, offset };
}
