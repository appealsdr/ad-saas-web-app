/**
 * POST /api/admin/issue-api-key — ops-only endpoint to mint a new bearer key
 * for server-to-server callers (see $lib/server/auth/api_key).
 *
 * Exists because the prod RDS instance sits in a private subnet (only
 * reachable from inside the VPC), so `scripts/issue-api-key.mjs` can't be run
 * from a laptop against prod — this runs inside App Runner instead, which
 * already has DB access.
 *
 * Guarded by a shared secret (ADMIN_OPS_SECRET), not user login — there is no
 * platform-wide admin role, only per-account owner/admin. Never returns an
 * existing key, only ever mints new ones; the raw key is shown once in the
 * response and is not retrievable afterward.
 */
import { json, error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { issueApiKey, type ApiScope } from '$lib/server/auth/api_key';

const VALID_SCOPES: ApiScope[] = ['provision', 'reset_password'];

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export const POST: RequestHandler = async ({ request }) => {
	const configuredSecret = env.ADMIN_OPS_SECRET;
	if (!configuredSecret) throw error(503, 'ADMIN_OPS_SECRET is not configured.');

	const providedSecret = request.headers.get('x-admin-secret') ?? '';
	if (!providedSecret || !safeEqual(providedSecret, configuredSecret)) {
		throw error(401, 'Invalid or missing x-admin-secret header.');
	}

	let body: { label?: string; scopes?: string[]; expiresAt?: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON.');
	}

	const label = String(body.label ?? '').trim();
	if (!label) throw error(400, 'label is required.');

	const scopes = Array.isArray(body.scopes) ? body.scopes : [];
	if (scopes.length === 0) throw error(400, `scopes is required. Valid scopes: ${VALID_SCOPES.join(', ')}`);
	for (const s of scopes) {
		if (!VALID_SCOPES.includes(s as ApiScope)) {
			throw error(400, `Invalid scope "${s}". Valid scopes: ${VALID_SCOPES.join(', ')}`);
		}
	}

	let expiresAt: Date | null = null;
	if (body.expiresAt) {
		expiresAt = new Date(body.expiresAt);
		if (Number.isNaN(expiresAt.getTime())) throw error(400, 'expiresAt is not a valid date.');
	}

	const { id, rawKey } = await issueApiKey(label, scopes as ApiScope[], expiresAt);

	return json(
		{
			id,
			label,
			scopes,
			expiresAt: expiresAt ? expiresAt.toISOString() : null,
			rawKey,
			warning: 'This key is shown once and cannot be retrieved again — store it now.'
		},
		{ status: 201 }
	);
};
