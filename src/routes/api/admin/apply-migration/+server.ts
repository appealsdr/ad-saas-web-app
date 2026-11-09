/**
 * POST /api/admin/apply-migration — ops-only, applies one whitelisted
 * db/migrations/*.sql file against the running app's own DATABASE_URL.
 *
 * Exists for the same reason as /api/admin/lookup-user and issue-api-key:
 * prod RDS sits in a subnet not reachable from a laptop, so
 * scripts/apply-migrations.sh can't be run against prod directly. This runs
 * inside App Runner instead, which already has DB access.
 *
 * Deliberately narrow: only runs a file whose name is in MIGRATION_ALLOWLIST,
 * read verbatim from db/migrations/ (no arbitrary SQL in the request body).
 * Every migration in this repo is written to be safe to re-run (IF NOT
 * EXISTS / IF EXISTS), so calling this twice is a no-op the second time.
 *
 * Guarded by the same shared secret as the other admin endpoints
 * (ADMIN_OPS_SECRET). Remove once the pending migration(s) below have run —
 * this is a one-off tool, not a general migration runner.
 */
import { json, error } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db';

const MIGRATION_ALLOWLIST = [
	'021_stripe_billing.sql',
	'022_stripe_webhook_events.sql',
	'023_platform_admin.sql',
	'024_admin_reporting_views.sql',
	'025_account_subscriptions.sql',
	'026_read_only_sessions.sql',
	'027_subscription_cancel_requested.sql',
	'028_line_item_balance_due.sql',
	'029_balance_payment_applications.sql',
	'030_standalone_admin_accounts.sql',
	'031_case_documents_multi_file.sql',
	'032_store_documents_multi_file.sql',
	'033_line_item_installments.sql'
];

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

	let body: { file?: string };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Body must be JSON.');
	}

	const file = String(body.file ?? '').trim();
	if (!MIGRATION_ALLOWLIST.includes(file)) {
		throw error(400, `file must be one of: ${MIGRATION_ALLOWLIST.join(', ')}`);
	}

	const filePath = path.join(process.cwd(), 'db', 'migrations', file);
	let contents: string;
	try {
		contents = await readFile(filePath, 'utf-8');
	} catch (e) {
		throw error(500, `Could not read migration file: ${e instanceof Error ? e.message : String(e)}`);
	}

	try {
		await sql.unsafe(contents);
	} catch (e) {
		throw error(500, `Migration failed: ${e instanceof Error ? e.message : String(e)}`);
	}

	return json({ ok: true, file });
};
