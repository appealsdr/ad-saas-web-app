/**
 * Benchmark on seeded multi-account data. Opt-in:
 *   BENCH=1 TEST_PG_URL=... npx vitest run tests/admin/bench.test.ts
 * Results are printed (not asserted tightly) and recorded in docs/admin-runbook.md.
 */
import { describe, it, expect } from 'vitest';
import { sql } from '$lib/server/db';
import { hasDb } from '../setup/db';
import { listAccounts, listAllUsers, parseAccountListQuery } from '$lib/server/admin/accounts';
import { queryLogs } from '$lib/server/admin/logs';
import { browseTable } from '$lib/server/admin/data/browse';

const ACCOUNTS = Number(process.env.BENCH_ACCOUNTS ?? 20000);

async function time<T>(label: string, fn: () => Promise<T>, runs = 5): Promise<T> {
	let out!: T;
	const ts: number[] = [];
	for (let i = 0; i < runs; i++) {
		const t0 = performance.now();
		out = await fn();
		ts.push(performance.now() - t0);
	}
	ts.sort((a, b) => a - b);
	console.log(`[bench] ${label.padEnd(58)} p50 ${ts[Math.floor(ts.length / 2)].toFixed(1)} ms   max ${ts[ts.length - 1].toFixed(1)} ms`);
	return out;
}

describe.skipIf(!hasDb || !process.env.BENCH)('admin list/log performance on seeded data', () => {
	it(`seeds ${ACCOUNTS} accounts and measures`, async () => {
		await sql`INSERT INTO accounts (name, email, onboarding_completed, sfdc_account_id, created_at)
			SELECT 'Bench Account ' || g, 'acct' || g || '@bench.test', g % 3 <> 0, CASE WHEN g % 2 = 0 THEN '001BENCH' || g END, now() - (g || ' minutes')::interval
			FROM generate_series(1, ${ACCOUNTS}) g`;
		await sql`INSERT INTO users (email, display_name, role, account_id, last_login_at)
			SELECT 'bench-u' || g || '-' || n || '@bench.test', 'User ' || n, CASE WHEN n = 1 THEN 'owner' ELSE 'member' END, a.id, now()
			FROM (SELECT id, row_number() OVER () AS g FROM accounts WHERE name LIKE 'Bench Account %') a, generate_series(1, 3) n`;
		await sql`INSERT INTO stores (account_id, name) SELECT id, 'Bench store' FROM accounts WHERE name LIKE 'Bench Account %' AND random() < 0.5`;
		await sql`INSERT INTO error_log (created_at, source, operation, severity, error_message, account_id)
			SELECT now() - (g || ' seconds')::interval, 'bench', 'op' || (g % 20), CASE WHEN g % 5 = 0 THEN 'warn' ELSE 'error' END, 'bench message ' || g,
			       CASE WHEN g % 4 = 0 THEN (SELECT id FROM accounts WHERE name = 'Bench Account ' || (1 + g % ${ACCOUNTS})) END
			FROM generate_series(1, 200000) g`;
		await sql`INSERT INTO activity_log (created_at, event_type, event_data) SELECT now() - (g || ' seconds')::interval, 'bench_event', '{}'::jsonb FROM generate_series(1, 200000) g`;
		await sql`ANALYZE`;

		const q = (o: Record<string, string> = {}) => parseAccountListQuery(new URLSearchParams(o));
		const [{ n: accts }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM accounts`;
		const [{ n: users }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users`;
		console.log(`[bench] dataset: ${accts} accounts, ${users} users`);

		await time('accounts list, page 1 (25), default sort', () => listAccounts(q()));
		await time('accounts list, page 400 (25)', () => listAccounts(q({ page: '400' })));
		await time('accounts list, 100/page, sort by users', () => listAccounts(q({ pageSize: '100', sort: 'users' })));
		await time('accounts list, search by name prefix', () => listAccounts(q({ q: 'Bench Account 123' })));
		await time('accounts list, search by Salesforce ID', () => listAccounts(q({ q: '001BENCH777' })));
		await time('accounts list, search by user email', () => listAccounts(q({ q: 'bench-u4242-1@bench' })));
		await time('accounts list, onboarding=incomplete', () => listAccounts(q({ onboarding: 'incomplete' })));
		await time('global users list, page 1', () => listAllUsers({ q: '', page: 1, pageSize: 25, filter: '' }));
		await time('global users search by email', () => listAllUsers({ q: 'bench-u9000-2', page: 1, pageSize: 25, filter: '' }));
		await time('logs: all sources, newest page (50)', () => queryLogs({ source: 'all', limit: 50 }));
		await time('logs: error source, deep cursor page', async () => {
			let r = await queryLogs({ source: 'error', limit: 100 });
			for (let i = 0; i < 20 && r.nextCursor; i++) r = await queryLogs({ source: 'error', limit: 100, cursor: r.nextCursor });
			return r;
		}, 3);
		await time('logs: filter by operation', () => queryLogs({ source: 'error', event: 'op7', limit: 50 }));
		await time('logs: filter by account', async () => {
			const [a] = await sql<{ account_id: string }[]>`SELECT account_id FROM error_log WHERE account_id IS NOT NULL LIMIT 1`;
			return queryLogs({ source: 'all', accountId: a.account_id, limit: 50 });
		});
		await time('logs: message text search (ILIKE, unindexed)', () => queryLogs({ source: 'error', text: 'bench message 1999', limit: 50 }), 3);
		await time('data explorer: users view page 1', () => browseTable({ table: 'users', page: 1, pageSize: 50 }));
		expect(true).toBe(true);
	}, 300_000);
});
