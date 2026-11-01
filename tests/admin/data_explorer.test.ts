import { describe, expect, it } from 'vitest';
import { hasDb, makeAccount, makeUser, uniq } from '../setup/db';
import { accountTableCounts, countAccountTable, exploreAccountTable, exportAccountRows } from '$lib/server/admin/data/browse';

const d = describe.skipIf(!hasDb);

const base = (accountId: string) => ({ table: 'users', accountId, page: 1, pageSize: 25 });
const c = (col: string, op: string, val = '', val2 = '') => ({ col, op, val, val2 });

d('account data explorer', () => {
	it('searches, filters, combines with logic, sorts, counts and exports — scoped to the account', async () => {
		const tag = uniq();
		const A = await makeAccount();
		const B = await makeAccount();
		await makeUser({ accountId: A.id, email: `alpha-${tag}@example.test`, role: 'owner' });
		await makeUser({ accountId: A.id, email: `beta-${tag}@example.test`, role: 'member' });
		await makeUser({ accountId: A.id, email: `gamma-${tag}@example.test`, role: 'member', active: false });
		await makeUser({ accountId: B.id, email: `other-${tag}@example.test`, role: 'member' });

		const all = await exploreAccountTable(base(A.id));
		expect(all.ok && all.total).toBe(3); // other account's user never leaks
		expect(all.ok && all.columns.some((x) => x.name === 'password_hash')).toBe(false);

		const search = await exploreAccountTable({ ...base(A.id), search: `BETA-${tag}` });
		expect(search.ok && search.total).toBe(1);

		const members = await exploreAccountTable({ ...base(A.id), conds: [c('role', 'eq', 'member')] });
		expect(members.ok && members.total).toBe(2);

		// 1 AND NOT 2  → members who are not inactive  (is_active is true)
		const logic = await exploreAccountTable({ ...base(A.id), conds: [c('role', 'eq', 'member'), c('is_active', 'false')], logic: '1 AND NOT 2' });
		expect(logic.ok && logic.total).toBe(1);

		const or = await exploreAccountTable({ ...base(A.id), conds: [c('role', 'eq', 'owner'), c('is_active', 'false')], logic: '1 OR 2' });
		expect(or.ok && or.total).toBe(2);

		// incomplete condition is ignored, numbering stays aligned
		const incomplete = await exploreAccountTable({ ...base(A.id), conds: [c('role', 'contains', ''), c('role', 'eq', 'owner')], logic: '2' });
		expect(incomplete.ok && incomplete.total).toBe(1);
		expect(incomplete.ok && incomplete.incomplete).toBe(1);

		const bad = await exploreAccountTable({ ...base(A.id), conds: [c('role', 'eq', 'owner')], logic: '1 AND 9' });
		expect(bad.ok && bad.filterError).toMatch(/doesn’t exist/);

		// injection attempts are plain values / ignored columns, never SQL
		const evil = await exploreAccountTable({ ...base(A.id), conds: [c('role', 'eq', "x' OR 1=1 --"), c('nope; drop table users', 'eq', 'a')] });
		expect(evil.ok && evil.total).toBe(0);
		const evilSort = await exploreAccountTable({ ...base(A.id), sort: 'email; drop table users' });
		expect(evilSort.ok && evilSort.total).toBe(3);

		const sorted = await exploreAccountTable({ ...base(A.id), sort: 'email', dir: 'asc' });
		expect(sorted.ok && sorted.rows.map((r) => String(r.email).split('-')[0])).toEqual(['alpha', 'beta', 'gamma']);

		const dates = await exploreAccountTable({ ...base(A.id), conds: [c('created_at', 'lastn', '1')] });
		expect(dates.ok && dates.total).toBe(3);
		const none = await exploreAccountTable({ ...base(A.id), conds: [c('created_at', 'before', '2000-01-01')] });
		expect(none.ok && none.total).toBe(0);

		const count = await countAccountTable({ ...base(A.id), conds: [c('role', 'eq', 'member')] });
		expect(count).toMatchObject({ total: 2, error: null });
		expect((await countAccountTable({ ...base(A.id), conds: [c('role', 'eq', 'a')], logic: '(1' })).error).toBeTruthy();

		const exp = await exportAccountRows({ ...base(A.id), conds: [c('role', 'eq', 'member')] });
		expect(exp?.rows).toHaveLength(2);
		expect(exp?.columns).not.toContain('password_hash');

		const counts = await accountTableCounts(A.id, ['users', 'stores']);
		expect(counts).toMatchObject({ users: 3, stores: 0 });
	});

	it('rejects tables that are not account-scoped', async () => {
		const A = await makeAccount();
		const r = await exploreAccountTable({ table: 'api_keys', accountId: A.id, page: 1, pageSize: 25 });
		expect(r.ok).toBe(false);
	});
});
