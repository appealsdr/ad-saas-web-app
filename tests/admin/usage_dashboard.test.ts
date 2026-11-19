import { describe, expect, it } from 'vitest';
import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeUser, uniq } from '../setup/db';
import { usageDashboard } from '$lib/server/admin/usage';
import { listAccounts, parseAccountListQuery } from '$lib/server/admin/accounts';

const d = describe.skipIf(!hasDb);

async function ev(userId: string, accountId: string, type: string, data: Record<string, unknown>, at: Date) {
	await sql`INSERT INTO activity_log (user_id, account_id, event_type, event_data, created_at) VALUES (${userId}, ${accountId}, ${type}, ${sql.json(data as never)}, ${at})`;
}

d('usage dashboard aggregation', () => {
	it('counts logins, views, visible time and active accounts inside the admin-zone period only', async () => {
		const A = await makeAccount();
		const u1 = await makeUser({ accountId: A.id, email: `a-${uniq()}@example.test` });
		const u2 = await makeUser({ accountId: A.id, email: `b-${uniq()}@example.test` });
		const path = `/probe-${uniq()}`;
		// Reference "now": 2026-11-18 20:00 New York (= 2026-11-19 01:00 UTC)
		const now = new Date('2026-11-19T01:00:00Z');
		const inToday = new Date('2026-11-18T15:00:00Z'); // 10:00 NY — inside "today" in New York
		const yesterdayNY = new Date('2026-11-18T03:00:00Z'); // 22:00 the day before in New York — outside
		await ev(u1.id, A.id, 'login', {}, inToday);
		await ev(u2.id, A.id, 'login', {}, inToday);
		await ev(u1.id, A.id, 'page_view', { path }, inToday);
		await ev(u1.id, A.id, 'page_view', { path }, inToday);
		await ev(u1.id, A.id, 'page_time', { path, ms: 60000 }, inToday);
		await ev(u1.id, A.id, 'page_time', { path, ms: 120000 }, inToday);
		await ev(u2.id, A.id, 'login', {}, yesterdayNY);

		const r = await usageDashboard({ period: 'today', tz: 'America/New_York', includeStaff: false }, now);
		const mine = (rows: { path: string }[]) => rows.find((x) => x.path === path);
		expect(r.totals.logins).toBeGreaterThanOrEqual(2); // other tests' rows may share the table
		expect(mine(r.topViews)).toMatchObject({ views: 2, users: 1 });
		expect(mine(r.topTime)).toMatchObject({ totalMs: 180000, avgMs: 90000, visits: 2 });
		expect(r.topAccounts.some((x) => x.id === A.id)).toBe(true);
		expect(r.trend).toHaveLength(24);
		expect(r.trend[10].users).toBeGreaterThanOrEqual(2); // hour 10 NY

		// The same instant in UTC terms: yesterday's NY evening login is "today" in UTC? (Nov 18 03:00Z is Nov 18 UTC)
		const utc = await usageDashboard({ period: 'today', tz: 'UTC', includeStaff: false }, new Date('2026-11-18T20:00:00Z'));
		expect(utc.trend).toHaveLength(24);
	});
});

d('accounts "last activity"', () => {
	it('is the newest activity_log event for the account, sorts last when missing, in one query', async () => {
		const tag = uniq();
		const A = await makeAccount({ name: `LastAct A ${tag}` });
		const B = await makeAccount({ name: `LastAct B ${tag}` });
		const u = await makeUser({ accountId: A.id, email: `la-${tag}@example.test` });
		const newest = new Date('2026-11-17T10:00:00Z');
		await ev(u.id, A.id, 'page_view', { path: '/x' }, new Date('2026-11-10T10:00:00Z'));
		await ev(u.id, A.id, 'click', { path: '/x' }, newest);
		for (const dir of ['asc', 'desc'] as const) {
			const q = parseAccountListQuery(new URLSearchParams(`q=LastAct&sort=activity&dir=${dir}&pageSize=100`));
			const { rows } = await listAccounts(q);
			const a = rows.find((x) => x.id === A.id)!;
			const b = rows.find((x) => x.id === B.id)!;
			expect(a.last_activity_at?.toISOString()).toBe(newest.toISOString());
			expect(b.last_activity_at).toBeNull();
			expect(rows.findIndex((x) => x.id === A.id)).toBeLessThan(rows.findIndex((x) => x.id === B.id)); // no-activity last in both directions
		}
	});
});
