import { describe, expect, it } from 'vitest';
import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeUser, uniq } from '../setup/db';
import { parseLogFilters, queryLogs, type LogEntry, type LogFilters } from '$lib/server/admin/logs';

const d = describe.skipIf(!hasDb);

async function pageAll(f: LogFilters): Promise<LogEntry[]> {
	const out: LogEntry[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < 200; i++) {
		const r = await queryLogs({ ...f, cursor, limit: 7 });
		out.push(...r.entries);
		if (!r.nextCursor) return out;
		cursor = r.nextCursor;
	}
	throw new Error('pagination did not terminate');
}

d('log viewer', () => {
	it('cursor pagination returns every retained record exactly once, even with identical timestamps, across all sources', async () => {
		const tag = `pg-${uniq()}`;
		const A = await makeAccount();
		const ts = new Date('2020-03-04T05:06:07.123456Z');
		for (let i = 0; i < 12; i++) {
			await sql`INSERT INTO error_log (created_at, source, operation, error_message, account_id) VALUES (${ts}, ${tag}, 'op', ${'e' + i}, ${A.id})`;
			await sql`INSERT INTO activity_log (created_at, event_type, account_id) VALUES (${ts}, ${tag}, ${A.id})`;
			await sql`INSERT INTO admin_audit_events (occurred_at, actor_ref, action, outcome, target_account_id) VALUES (${ts}, 't', ${tag}, 'success', ${A.id})`;
		}
		const all = await pageAll({ source: 'all', accountId: A.id });
		expect(all).toHaveLength(36);
		expect(new Set(all.map((e) => e.source + e.id)).size).toBe(36); // no duplicates
		expect(new Set(all.map((e) => e.source))).toEqual(new Set(['error', 'activity', 'audit']));
		// strictly descending (ts, id)
		for (let i = 1; i < all.length; i++) {
			const a = all[i - 1], b = all[i];
			expect(a.ts >= b.ts).toBe(true);
			if (a.ts === b.ts) expect(a.id > b.id).toBe(true);
		}
		expect(await pageAll({ source: 'error', accountId: A.id })).toHaveLength(12);
		expect(await pageAll({ source: 'audit', accountId: A.id })).toHaveLength(12);
	});

	it('page size is bounded', async () => {
		const r = await queryLogs({ source: 'all', limit: 100000 });
		expect(r.limit).toBe(100);
		expect(r.entries.length).toBeLessThanOrEqual(100);
	});

	it('redacts legacy rows that were stored un-redacted (nested JSON, message, stack)', async () => {
		const tag = `legacy-${uniq()}`;
		await sql`
			INSERT INTO error_log (source, operation, error_message, stack, context)
			VALUES (${tag}, 'legacy', 'SF auth failed: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sigsigsigsig token=abc999secret',
			        'Error\n at connect postgres://app:Sup3rSecret@db:5432/x',
			        ${sql.json({ request: { headers: { authorization: 'Bearer abcdefghijkl', cookie: 'session=zzz' } }, creds: [{ password: 'hunter2' }, { ok: 'visible' }], url: 'https://x.test/cb?token=leaky123&a=1' })})`;
		const [e] = (await queryLogs({ source: 'error', event: 'legacy', text: undefined, limit: 100 })).entries.filter((x) => x.origin === tag);
		const dump = JSON.stringify(e);
		for (const leak of ['eyJhbGci', 'abc999secret', 'Sup3rSecret', 'abcdefghijkl', 'zzz', 'hunter2', 'leaky123']) expect(dump, leak).not.toContain(leak);
		expect(dump).toContain('visible');
		expect(e.missing.join(' ')).toMatch(/unattributed/);
	});

	it('legacy rows without account/request ids are shown globally and explicitly unattributed — never guessed', async () => {
		const A = await makeAccount();
		const u = await makeUser({ accountId: A.id });
		const tag = `unattr-${uniq()}`;
		await sql`INSERT INTO activity_log (user_id, event_type, event_data) VALUES (${u.id}, ${tag}, ${sql.json({ screen: 'x' })})`;
		await sql`INSERT INTO error_log (user_id, source, operation, error_message) VALUES (${u.id}, ${tag}, 'op', 'user error')`;
		const unattributed = await queryLogs({ source: 'all', event: tag, accountId: 'unattributed', limit: 50 });
		expect(unattributed.entries.some((e) => e.source === 'activity' && e.event === tag && e.accountId === null)).toBe(true);
		// the user's CURRENT account must not claim these historical rows
		const forAccount = await queryLogs({ source: 'all', event: tag, accountId: A.id, limit: 50 });
		expect(forAccount.entries).toHaveLength(0);
		const all = await queryLogs({ source: 'all', event: tag, limit: 50 });
		expect(all.entries.length).toBeGreaterThanOrEqual(1);
		for (const e of all.entries) expect(e.missing.join(' ')).toMatch(/unattributed|No account/);
	});

	it('filters: severity, operation/event, actor, request id, date range, message text', async () => {
		const tag = `flt-${uniq()}`;
		const u = await makeUser();
		const rid = `rid-${uniq()}`;
		await sql`INSERT INTO error_log (created_at, source, operation, severity, user_id, request_id, error_message) VALUES ('2021-01-01T00:00:00Z', ${tag}, 'alpha', 'warn', ${u.id}, ${rid}, 'needle in haystack 100% real_value')`;
		await sql`INSERT INTO error_log (created_at, source, operation, severity, error_message) VALUES ('2021-06-01T00:00:00Z', ${tag}, 'beta', 'error', 'something else')`;
		const base = { source: 'error' as const, limit: 50 };
		expect((await queryLogs({ ...base, severity: 'warn', text: tag })).entries.map((e) => e.event)).toEqual(['alpha']);
		expect((await queryLogs({ ...base, event: 'beta' })).entries.every((e) => e.event === 'beta')).toBe(true);
		expect((await queryLogs({ ...base, actorUserId: u.id })).entries).toHaveLength(1);
		expect((await queryLogs({ ...base, requestId: rid })).entries).toHaveLength(1);
		expect((await queryLogs({ ...base, text: tag, from: new Date('2021-03-01'), to: new Date('2021-12-31') })).entries.map((e) => e.event)).toEqual(['beta']);
		expect((await queryLogs({ ...base, text: 'needle in haystack' })).entries).toHaveLength(1);
		expect((await queryLogs({ ...base, text: '100% real_value' })).entries).toHaveLength(1);
		expect((await queryLogs({ ...base, text: '%' })).entries.every((e) => (e.message ?? '').includes('%') || e.event.includes('%') || (e.origin ?? '').includes('%'))).toBe(true);
		expect((await queryLogs({ ...base, actorUserId: 'not-a-uuid' })).entries).toHaveLength(0); // invalid filter → no rows, no SQL error
		expect((await queryLogs({ ...base, accountId: "x' or 1=1 --" })).entries).toHaveLength(0);
	});

	it('severity filter excludes sources that have no severity rather than faking one', async () => {
		const r = await queryLogs({ source: 'all', severity: 'error', limit: 100 });
		expect(r.entries.every((e) => e.source === 'error')).toBe(true);
	});

	it('shows admin audit records (actor, action, outcome, request id) and keeps XSS payloads inert text', async () => {
		const xss = `<script>alert('x')</script>`;
		const tag = `audit-${uniq()}`;
		await sql`INSERT INTO admin_audit_events (actor_ref, action, outcome, reason, request_id, metadata) VALUES ('a@b.test', ${tag}, 'denied', ${xss}, 'req-1', ${sql.json({ note: xss, password: 'p' })})`;
		const e = (await queryLogs({ source: 'audit', event: tag })).entries[0];
		expect(e.origin).toBe('denied');
		expect(e.requestId).toBe('req-1');
		expect(e.message).toBe(xss); // returned as data; Svelte escapes it (no {@html})
		expect(JSON.stringify(e.details)).not.toContain('"p"');
	});

	it('parseLogFilters ignores bad dates and clamps input', () => {
		const f = parseLogFilters(new URLSearchParams('source=bogus&from=garbage&limit=99999&account=ignored-when-fixed'), 'fixed-account');
		expect(f.source).toBe('all');
		expect(f.from).toBeNull();
		expect(f.accountId).toBe('fixed-account');
	});
});
