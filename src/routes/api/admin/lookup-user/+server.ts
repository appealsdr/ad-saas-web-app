/**
 * GET /api/admin/lookup-user?email=... — ops-only, read-only lookup for a
 * user's local + Salesforce IDs by email.
 *
 * Exists for the same reason as /api/admin/issue-api-key: prod RDS sits in a
 * private subnet (no console/laptop access), and RDS Query Editor only
 * supports Aurora Serverless, not this instance. This runs inside App Runner,
 * which already has DB access, and never writes.
 *
 * Guarded by the same shared secret as issue-api-key (ADMIN_OPS_SECRET).
 */
import { json, error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db';

function safeEqual(a: string, b: string): boolean {
	const bufA = Buffer.from(a);
	const bufB = Buffer.from(b);
	if (bufA.length !== bufB.length) return false;
	return timingSafeEqual(bufA, bufB);
}

export const GET: RequestHandler = async ({ request, url }) => {
	const configuredSecret = env.ADMIN_OPS_SECRET;
	if (!configuredSecret) throw error(503, 'ADMIN_OPS_SECRET is not configured.');

	const providedSecret = request.headers.get('x-admin-secret') ?? '';
	if (!providedSecret || !safeEqual(providedSecret, configuredSecret)) {
		throw error(401, 'Invalid or missing x-admin-secret header.');
	}

	const email = (url.searchParams.get('email') ?? '').trim().toLowerCase();
	if (!email) throw error(400, 'email query param is required.');

	const rows = await sql<
		{
			user_id: string;
			email: string;
			account_id: string;
			account_name: string;
			sfdc_contact_id: string | null;
			sfdc_account_id: string | null;
			created_at: Date;
		}[]
	>`
		SELECT u.id AS user_id, u.email, u.account_id, a.name AS account_name,
		       u.sfdc_contact_id, u.sfdc_account_id, u.created_at
		FROM users u
		JOIN accounts a ON a.id = u.account_id
		WHERE u.email = ${email}
	`;

	return json({ email, matches: rows });
};
