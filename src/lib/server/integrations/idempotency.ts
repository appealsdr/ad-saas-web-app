/**
 * Idempotency for write endpoints, isolated per integration:
 * UNIQUE (integration_client_id, operation, idempotency_key).
 *
 * Header: `Idempotency-Key: <1-128 chars of [A-Za-z0-9._:-]>` (optional).
 * Same key + same request → the stored response is replayed. Same key but a
 * different request → 422. Same key while the first call is still running → 409.
 * A failed (5xx) attempt releases the key so the client can retry.
 */
import { createHash } from 'node:crypto';
import { sql } from '../db';
import { ApiError } from './errors';

const KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

export function readIdempotencyKey(request: Request): string | null {
	const raw = request.headers.get('idempotency-key');
	if (raw === null) return null;
	const k = raw.trim();
	if (!KEY_RE.test(k)) throw new ApiError(400, 'INVALID_IDEMPOTENCY_KEY', 'Idempotency-Key must be 1-128 characters of A-Z a-z 0-9 . _ : -');
	return k;
}

export function hashRequest(...parts: (string | Uint8Array)[]): string {
	const h = createHash('sha256');
	for (const p of parts) {
		h.update(typeof p === 'string' ? Buffer.from(p) : p);
		h.update('\u0000');
	}
	return h.digest('hex');
}

export interface StoredResponse {
	status: number;
	body: unknown;
}

/**
 * Run `fn` at most once per (integration, operation, key). Without a key the
 * call just runs. Responses with status < 500 are stored and replayed.
 */
export async function withIdempotency(
	integrationId: string,
	operation: string,
	key: string | null,
	requestHash: string,
	fn: () => Promise<StoredResponse>
): Promise<StoredResponse & { replayed: boolean }> {
	if (!key) return { ...(await fn()), replayed: false };

	const inserted = await sql<{ id: string }[]>`
		INSERT INTO integration_idempotency_keys (integration_client_id, operation, idempotency_key, request_hash)
		VALUES (${integrationId}, ${operation}, ${key}, ${requestHash})
		ON CONFLICT (integration_client_id, operation, idempotency_key) DO NOTHING
		RETURNING id
	`;

	if (!inserted[0]) {
		const [existing] = await sql<
			{ id: string; request_hash: string; state: string; response_status: number | null; response_body: unknown; expires_at: Date }[]
		>`
			SELECT id, request_hash, state, response_status, response_body, expires_at
			FROM integration_idempotency_keys
			WHERE integration_client_id = ${integrationId} AND operation = ${operation} AND idempotency_key = ${key}
		`;
		if (existing && existing.expires_at.getTime() <= Date.now()) {
			// Expired record: reclaim it and run normally.
			await sql`DELETE FROM integration_idempotency_keys WHERE id = ${existing.id}`;
			return withIdempotency(integrationId, operation, key, requestHash, fn);
		}
		if (!existing) return withIdempotency(integrationId, operation, key, requestHash, fn); // released between statements
		if (existing.request_hash !== requestHash) {
			throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request.');
		}
		if (existing.state !== 'completed') {
			throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed.');
		}
		return { status: existing.response_status ?? 200, body: existing.response_body, replayed: true };
	}

	const recordId = inserted[0].id;
	try {
		const result = await fn();
		if (result.status >= 500) {
			await sql`DELETE FROM integration_idempotency_keys WHERE id = ${recordId}`.catch(() => {});
		} else {
			await sql`
				UPDATE integration_idempotency_keys
				SET state = 'completed', response_status = ${result.status},
				    response_body = ${sql.json(result.body as Parameters<typeof sql.json>[0])}
				WHERE id = ${recordId}
			`;
		}
		return { ...result, replayed: false };
	} catch (e) {
		// Client errors (ApiError < 500) are deterministic and not stored; release so a corrected retry works.
		await sql`DELETE FROM integration_idempotency_keys WHERE id = ${recordId}`.catch(() => {});
		throw e;
	}
}
