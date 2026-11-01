import { beforeEach, describe, expect, it, vi } from 'vitest';

const sf = vi.hoisted(() => ({ update: vi.fn(), email: vi.fn(), changed: vi.fn() }));
vi.mock('$lib/server/salesforce/records', () => ({
	updateSalesforceAccount: sf.update,
	fetchSalesforceAccount: vi.fn()
}));
vi.mock('$lib/server/storage/s3', () => ({ deleteObject: vi.fn() }));
vi.mock('$lib/server/salesforce/email', () => ({ sendPasswordResetEmail: sf.email, sendPasswordChangedEmail: sf.changed }));

import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeStaff, makeStore, makeUser, uniq } from '../setup/db';
import {
	accountSummary, getAccount, getAccountUser, listAccounts, listAccountContracts, listAccountDocuments,
	listAccountStores, listAccountUsers, listAllUsers, parseAccountListQuery
} from '$lib/server/admin/accounts';
import { ActionError, deleteAccountCascade, initiatePasswordReset, manageCustomerUser, setTemporaryPassword, updateAccountFields } from '$lib/server/admin/actions';
import { browseTable } from '$lib/server/admin/data/browse';
import { requestContext } from '$lib/server/admin/request_context';
import { logError } from '$lib/server/error_log';

const d = describe.skipIf(!hasDb);
const actor = { userId: null as string | null, ref: 'tester@example.test', role: 'platform_admin' };
const q = (o: Record<string, string> = {}) => parseAccountListQuery(new URLSearchParams(o));

d('accounts list', () => {
	it('lists EVERY account, including incomplete, ownerless, store-less and unlinked ones', async () => {
		const broken = await makeAccount({ name: `Broken ${uniq()}`, onboarding: false, email: null });
		const linked = await makeAccount({ name: `Linked ${uniq()}`, sfdc: `001${uniq()}` });
		const owner = await makeUser({ role: 'owner', accountId: linked.id });
		await makeStore(linked.id);
		const res = await listAccounts(q({ pageSize: '100', q: '' }));
		const ids = res.rows.map((r) => r.id);
		expect(ids).toContain(broken.id);
		const b = res.rows.find((r) => r.id === broken.id)!;
		expect(b).toMatchObject({ user_count: 0, store_count: 0, onboarding_completed: false, owner_email: null, account_email: null });
		const l = (await listAccounts(q({ q: linked.name }))).rows[0];
		expect(l).toMatchObject({ owner_email: owner.email, user_count: 1, store_count: 1 });
	});
	it('searches by name, email, local ID (full and prefix) and Salesforce ID; filters onboarding', async () => {
		const sfid = `001ZZ${uniq()}`;
		const a = await makeAccount({ name: `Searchable ${uniq()}`, sfdc: sfid, onboarding: false });
		const u = await makeUser({ accountId: a.id, email: `needle-${uniq()}@find.test` });
		for (const term of [a.name, a.name.toUpperCase(), a.id, a.id.slice(0, 8), sfid, u.email, 'needle-']) {
			const r = await listAccounts(q({ q: term }));
			expect(r.rows.map((x) => x.id), term).toContain(a.id);
		}
		expect((await listAccounts(q({ q: a.name, onboarding: 'complete' }))).rows).toHaveLength(0);
		expect((await listAccounts(q({ q: a.name, onboarding: 'incomplete' }))).rows).toHaveLength(1);
		expect((await listAccounts(q({ q: "%' OR 1=1 --" }))).rows).toHaveLength(0);
		expect((await listAccounts(q({ q: '%' }))).total).toBe(0); // wildcard is literal
	});
	it('paginates deterministically with a hard cap of 100', async () => {
		for (let i = 0; i < 6; i++) await makeAccount({ name: `Page ${i}` });
		const p1 = await listAccounts(q({ pageSize: '2', page: '1', sort: 'name', dir: 'asc' }));
		const p2 = await listAccounts(q({ pageSize: '2', page: '2', sort: 'name', dir: 'asc' }));
		expect(p1.rows).toHaveLength(2);
		expect(p1.rows.map((r) => r.id)).not.toEqual(p2.rows.map((r) => r.id));
		expect((await listAccounts(q({ pageSize: '100000' }))).pageSize).toBe(100);
		const again = await listAccounts(q({ pageSize: '2', page: '1', sort: 'name', dir: 'asc' }));
		expect(again.rows.map((r) => r.id)).toEqual(p1.rows.map((r) => r.id));
	});
	it('sort keys are allowlisted (no SQL injection through sort/dir)', async () => {
		const p = q({ sort: 'name; drop table accounts', dir: 'asc; drop' });
		expect(p.sort).toBe('created');
		expect(p.dir).toBe('desc');
		await expect(listAccounts(p)).resolves.toBeTruthy();
	});
});

d('account workspace isolation (two accounts, tampered child IDs)', () => {
	it('each account shows only its own users, stores, contracts and documents', async () => {
		const A = await makeAccount({ name: `A ${uniq()}` }); const B = await makeAccount({ name: `B ${uniq()}` });
		const ua = await makeUser({ accountId: A.id }); const ub = await makeUser({ accountId: B.id });
		const sa = await makeStore(A.id, 'Store of A'); const sb = await makeStore(B.id, 'Store of B');
		await sql`INSERT INTO service_contracts (account_id, store_id, kind, amount_cents, currency, paid_at, start_date, end_date, stripe_payment_intent_id) VALUES (${A.id}, ${sa}, 'service', 1000, 'usd', now(), now(), now(), ${'pi_' + uniq()}), (${B.id}, ${sb}, 'service', 2000, 'usd', now(), now(), now(), ${'pi_' + uniq()})`;
		await sql`INSERT INTO store_documents (store_id, original_name, storage_path, size_bytes) VALUES (${sa}, 'a.pdf', 'a', 1), (${sb}, 'b.pdf', 'b', 1)`;
		await sql`INSERT INTO case_documents (store_id, sfdc_case_id, original_name, s3_bucket, s3_key, size_bytes) VALUES (${sb}, '500B', 'bc.pdf', 'b', 'k', 1)`;

		expect((await listAccountUsers(A.id)).map((u) => u.id)).toEqual([ua.id]);
		expect((await listAccountUsers(B.id)).map((u) => u.id)).toEqual([ub.id]);
		expect((await listAccountStores(A.id)).map((s) => s.name)).toEqual(['Store of A']);
		expect((await listAccountContracts(B.id)).map((c) => c.amount_cents)).toEqual(['2000']);
		expect((await listAccountDocuments(A.id)).map((x) => x.original_name)).toEqual(['a.pdf']);
		expect((await listAccountDocuments(B.id)).map((x) => x.original_name).sort()).toEqual(['b.pdf', 'bc.pdf']);
		expect(await accountSummary(A.id)).toMatchObject({ users: 1, stores: 1, contracts: 1 });
	});
	it('a child ID from another account never resolves inside the selected account', async () => {
		const A = await makeAccount(); const B = await makeAccount();
		const ub = await makeUser({ accountId: B.id });
		expect(await getAccountUser(A.id, ub.id)).toBeNull(); // tampered user id
		await expect(manageCustomerUser({ actor }, A.id, ub.id, 'suspend', 'tamper test', ub.email)).rejects.toMatchObject({ status: 404 });
		await expect(initiatePasswordReset({ actor, origin: 'http://x' }, A.id, ub.id, 'tamper test', ub.email)).rejects.toMatchObject({ status: 404 });
		const [still] = await sql<{ is_active: boolean }[]>`SELECT is_active FROM users WHERE id = ${ub.id}`;
		expect(still.is_active).toBe(true);
		// account-scoped data browser ignores rows of other accounts
		const r = await browseTable({ table: 'users', page: 1, pageSize: 50, accountId: A.id });
		expect(r.ok && r.rows.some((row) => row.id === ub.id)).toBe(false);
		const rb = await browseTable({ table: 'users', page: 1, pageSize: 50, accountId: B.id });
		expect(rb.ok && rb.rows.some((row) => row.id === ub.id)).toBe(true);
		// global tables refuse account scoping rather than pretending
		expect((await browseTable({ table: 'api_keys', page: 1, pageSize: 5, accountId: A.id })).ok).toBe(false);
	});
	it('global users include people with no account', async () => {
		const orphan = await makeUser({ accountId: null });
		const r = await listAllUsers({ q: orphan.email, page: 1, pageSize: 25, filter: '' });
		expect(r.rows[0]).toMatchObject({ id: orphan.id, account_id: null, account_name: null });
		expect((await listAllUsers({ q: '', page: 1, pageSize: 100, filter: 'no_account' })).rows.some((x) => x.id === orphan.id)).toBe(true);
	});
	it('selecting an account does not change the administrator\'s own account/identity', async () => {
		const staff = await makeStaff('platform_admin');
		const A = await makeAccount();
		await getAccount(A.id); await listAccountUsers(A.id);
		expect(await sql`SELECT 1 FROM users WHERE id = ${staff.id}`).toHaveLength(0); // an admin is not a customer user at all
		const [s] = await sql`SELECT 1 FROM sessions WHERE user_id = ${staff.id}`;
		expect(s).toBeUndefined(); // no customer session issued
	});
});

d('account edits', () => {
	beforeEach(() => { sf.update.mockReset(); sf.email.mockReset(); sf.changed.mockReset(); });

	it('saves company fields locally, audits atomically and pushes them to the Salesforce Account', async () => {
		const a = await makeAccount({ sfdc: '001PHONE' });
		sf.update.mockResolvedValueOnce({ ok: true });
		const cur = (await getAccount(a.id))!;
		const r = await updateAccountFields({ actor }, a.id, cur.version, { phone: '555-0100' });
		expect(r).toMatchObject({ changed: ['phone'], salesforce: 'synced' });
		expect(sf.update).toHaveBeenCalledWith('001PHONE', { Phone: '555-0100' }, { accountId: a.id });
		const [ev] = await sql<{ metadata: any }[]>`SELECT metadata FROM admin_audit_events WHERE action = 'account.update' AND target_account_id = ${a.id}`;
		expect(ev.metadata.changes.phone.to).toBe('555-0100');
		expect(ev.metadata.ownership.phone).toBe('salesforce-synced');
	});
	it('company name and email are editable and map to Account.Name / Primary_Email__c; name cannot be blank', async () => {
		const a = await makeAccount({ sfdc: '001NAME' });
		sf.update.mockResolvedValueOnce({ ok: true });
		let cur = (await getAccount(a.id))!;
		await updateAccountFields({ actor }, a.id, cur.version, { name: 'Renamed Co', email: 'new@example.test' });
		expect(sf.update).toHaveBeenCalledWith('001NAME', { Name: 'Renamed Co', Primary_Email__c: 'new@example.test' }, { accountId: a.id });
		cur = (await getAccount(a.id))!;
		await expect(updateAccountFields({ actor }, a.id, cur.version, { name: '  ' })).rejects.toThrow(/name is required/i);
	});
	it('billing edits sync to Salesforce through the existing service; failure is reported, not hidden', async () => {
		const a = await makeAccount({ sfdc: '001SYNC' });
		sf.update.mockResolvedValueOnce({ ok: true });
		let cur = (await getAccount(a.id))!;
		const ok = await updateAccountFields({ actor }, a.id, cur.version, { billing_city: 'Austin' });
		expect(ok.salesforce).toBe('synced');
		expect(sf.update).toHaveBeenCalledWith('001SYNC', { BillingCity: 'Austin' }, { accountId: a.id });

		sf.update.mockResolvedValueOnce({ ok: false, error: 'REQUEST_LIMIT_EXCEEDED' });
		cur = (await getAccount(a.id))!;
		const bad = await updateAccountFields({ actor }, a.id, cur.version, { billing_city: 'Dallas' });
		expect(bad).toMatchObject({ salesforce: 'failed', salesforceError: 'REQUEST_LIMIT_EXCEEDED' });
		expect((await getAccount(a.id))!.billing_city).toBe('Dallas'); // local change is durable
		const rows = await sql<{ outcome: string }[]>`SELECT outcome FROM admin_audit_events WHERE action = 'account.salesforce_sync' AND target_account_id = ${a.id} ORDER BY occurred_at, id`;
		expect(rows.map((r) => r.outcome)).toEqual(expect.arrayContaining(['pending', 'success', 'failure']));
	});
	it('unlinked accounts report "not linked" rather than success', async () => {
		const a = await makeAccount({ sfdc: null });
		const cur = (await getAccount(a.id))!;
		expect((await updateAccountFields({ actor }, a.id, cur.version, { billing_country: 'US' })).salesforce).toBe('not_linked');
	});
	it('protects against lost updates with a version precondition', async () => {
		const a = await makeAccount();
		const stale = (await getAccount(a.id))!.version;
		await updateAccountFields({ actor }, a.id, stale, { phone: '1' });
		await expect(updateAccountFields({ actor }, a.id, stale, { phone: '2' })).rejects.toMatchObject({ status: 409 });
		expect((await getAccount(a.id))!.phone).toBe('1');
		// concurrent edits: exactly one wins
		const v = (await getAccount(a.id))!.version;
		const res = await Promise.allSettled([updateAccountFields({ actor }, a.id, v, { website: 'a.test' }), updateAccountFields({ actor }, a.id, v, { website: 'b.test' })]);
		expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
	});
	it('only approved fields can change and unknown keys are ignored', async () => {
		const a = await makeAccount();
		const cur = (await getAccount(a.id))!;
		await expect(updateAccountFields({ actor }, a.id, cur.version, { stripe_customer_id: 'cus_x', sfdc_account_id: 'x', onboarding_completed: false } as any)).rejects.toThrow(/No changes/);
		const after = (await getAccount(a.id))!;
		expect(after.name).toBe(a.name);
		expect(after.stripe_customer_id).toBeNull();
	});
	it('a failing audit insert rolls the mutation back (atomic)', async () => {
		const a = await makeAccount();
		await sql`CREATE OR REPLACE FUNCTION zz_fail_audit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$ LANGUAGE plpgsql`;
		await sql`CREATE TRIGGER zz_fail BEFORE INSERT ON admin_audit_events FOR EACH ROW WHEN (NEW.action = 'account.update') EXECUTE FUNCTION zz_fail_audit()`;
		try {
			const cur = (await getAccount(a.id))!;
			await expect(updateAccountFields({ actor }, a.id, cur.version, { phone: 'should-not-persist' })).rejects.toThrow(/audit down/);
			expect((await getAccount(a.id))!.phone).toBeNull();
		} finally {
			await sql`DROP TRIGGER zz_fail ON admin_audit_events`;
			await sql`DROP FUNCTION zz_fail_audit()`;
		}
	});
});

d('customer user management', () => {
	beforeEach(() => { sf.update.mockReset(); sf.email.mockReset(); });
	const setup = async () => {
		const A = await makeAccount(); const u = await makeUser({ accountId: A.id, role: 'member' });
		return { A, u };
	};

	it('requires a reason and an exact confirmation', async () => {
		const { A, u } = await setup();
		await expect(manageCustomerUser({ actor }, A.id, u.id, 'suspend', '', u.email)).rejects.toMatchObject({ status: 422 });
		await expect(manageCustomerUser({ actor }, A.id, u.id, 'suspend', 'abc', u.email)).rejects.toMatchObject({ status: 422 });
		await expect(manageCustomerUser({ actor }, A.id, u.id, 'suspend', 'valid reason here', 'wrong@x.test')).rejects.toMatchObject({ status: 422 });
		const [x] = await sql<{ is_active: boolean }[]>`SELECT is_active FROM users WHERE id = ${u.id}`;
		expect(x.is_active).toBe(true);
	});
	it('suspend → revokes customer sessions, audited with reason; reactivate; unlock', async () => {
		const { A, u } = await setup();
		await sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${u.id}, ${'h-' + uniq()}, now() + interval '1h')`;
		await manageCustomerUser({ actor }, A.id, u.id, 'suspend', 'fraud review #1', u.email);
		const [x] = await sql<{ is_active: boolean }[]>`SELECT is_active FROM users WHERE id = ${u.id}`;
		expect(x.is_active).toBe(false);
		expect(await sql`SELECT 1 FROM sessions WHERE user_id = ${u.id}`).toHaveLength(0);
		await expect(manageCustomerUser({ actor }, A.id, u.id, 'suspend', 'again again', u.email)).rejects.toMatchObject({ status: 409 });
		await manageCustomerUser({ actor }, A.id, u.id, 'reactivate', 'review cleared', u.email);
		await sql`UPDATE users SET locked_until = now() + interval '1 day', failed_login_attempts = 3 WHERE id = ${u.id}`;
		await manageCustomerUser({ actor }, A.id, u.id, 'unlock', 'customer verified by phone', u.email);
		const [y] = await sql<{ locked_until: Date | null; failed_login_attempts: number; is_active: boolean }[]>`SELECT locked_until, failed_login_attempts, is_active FROM users WHERE id = ${u.id}`;
		expect(y).toMatchObject({ locked_until: null, failed_login_attempts: 0, is_active: true });
		const ev = await sql<{ action: string; reason: string; target_account_id: string; actor_ref: string }[]>`SELECT action, reason, target_account_id, actor_ref FROM admin_audit_events WHERE target_id = ${u.id} ORDER BY occurred_at`;
		expect(ev.map((e) => e.action)).toEqual(['user.suspend', 'user.reactivate', 'user.unlock']);
		expect(ev[0]).toMatchObject({ reason: 'fraud review #1', target_account_id: A.id, actor_ref: actor.ref });
	});
	it('an admin id is never a customer user, so it cannot be managed through the customer path', async () => {
		const A = await makeAccount();
		const staff = await makeStaff('platform_admin');
		await expect(manageCustomerUser({ actor }, A.id, staff.id, 'suspend', 'trying to lock out admin', staff.email)).rejects.toMatchObject({ status: 404 });
	});
	it('suspend and audit are atomic (audit failure → user stays active, sessions kept)', async () => {
		const { A, u } = await setup();
		await sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${u.id}, ${'h-' + uniq()}, now() + interval '1h')`;
		await sql`CREATE OR REPLACE FUNCTION zz_fail_audit2() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'audit down'; END $$ LANGUAGE plpgsql`;
		await sql`CREATE TRIGGER zz_fail2 BEFORE INSERT ON admin_audit_events FOR EACH ROW WHEN (NEW.action = 'user.suspend') EXECUTE FUNCTION zz_fail_audit2()`;
		try {
			await expect(manageCustomerUser({ actor }, A.id, u.id, 'suspend', 'atomicity test', u.email)).rejects.toThrow(/audit down/);
			const [x] = await sql<{ is_active: boolean }[]>`SELECT is_active FROM users WHERE id = ${u.id}`;
			expect(x.is_active).toBe(true);
			expect(await sql`SELECT 1 FROM sessions WHERE user_id = ${u.id}`).toHaveLength(1);
		} finally {
			await sql`DROP TRIGGER zz_fail2 ON admin_audit_events`;
			await sql`DROP FUNCTION zz_fail_audit2()`;
		}
	});
	it('password reset: sends via the existing email flow, never returns the token', async () => {
		const { A, u } = await setup();
		sf.email.mockResolvedValueOnce(undefined);
		const r = await initiatePasswordReset({ actor, origin: 'https://app.test' }, A.id, u.id, 'customer locked out', u.email);
		expect(JSON.stringify(r)).not.toMatch(/token=|[0-9a-f]{64}/);
		expect(sf.email).toHaveBeenCalledTimes(1);
		const [, link] = sf.email.mock.calls[0];
		expect(link).toMatch(/^https:\/\/app\.test\/reset-password\?token=[0-9a-f]{64}$/);
		expect(await sql`SELECT 1 FROM password_reset_tokens WHERE user_id = ${u.id}`).toHaveLength(1);
		const ev = await sql<{ outcome: string }[]>`SELECT outcome FROM admin_audit_events WHERE action = 'user.password_reset.initiate' AND target_id = ${u.id}`;
		expect(ev.map((e) => e.outcome).sort()).toEqual(['pending', 'success']);
		expect(JSON.stringify(await sql`SELECT metadata FROM admin_audit_events WHERE target_id = ${u.id}`)).not.toMatch(/[0-9a-f]{64}/);
	});
	it('password reset delivery failure is visible, issues no usable token, and is audited', async () => {
		const { A, u } = await setup();
		sf.email.mockRejectedValueOnce(new Error('SES unavailable'));
		await expect(initiatePasswordReset({ actor, origin: 'https://app.test' }, A.id, u.id, 'customer locked out', u.email)).rejects.toMatchObject({ status: 502 });
		expect(await sql`SELECT 1 FROM password_reset_tokens WHERE user_id = ${u.id}`).toHaveLength(0);
		const ev = await sql<{ outcome: string }[]>`SELECT outcome FROM admin_audit_events WHERE action = 'user.password_reset.initiate' AND target_id = ${u.id}`;
		expect(ev.map((e) => e.outcome)).toContain('failure');
	});
	it('reasons containing HTML are stored verbatim as data (rendered escaped by Svelte)', async () => {
		const { A, u } = await setup();
		const xss = '<img src=x onerror=alert(1)>';
		await manageCustomerUser({ actor }, A.id, u.id, 'revoke_sessions', xss, u.email);
		const [e] = await sql<{ reason: string }[]>`SELECT reason FROM admin_audit_events WHERE target_id = ${u.id}`;
		expect(e.reason).toBe(xss);
	});
});

d('request correlation on new log writes', () => {
	it('logError inside a request records request_id/account and redacts secrets before storage', async () => {
		const A = await makeAccount();
		const rid = `req-${uniq()}`;
		await requestContext.run({ requestId: rid, accountId: A.id }, () =>
			logError({
				source: 'test', operation: 'op', errorMessage: 'upstream said Bearer abcdefghijklmnopqrst',
				stack: 'Error: x\n at password=hunter2', context: { access_token: 'tok', nested: { client_secret: 's', ok: 1 } }
			})
		);
		const [row] = await sql<any[]>`SELECT * FROM error_log WHERE request_id = ${rid}`;
		expect(row.account_id).toBe(A.id);
		expect(JSON.stringify(row)).not.toMatch(/abcdefghijklmnopqrst|hunter2|"tok"|"s"/);
		expect(row.context.nested.ok).toBe(1);
	});
	it('without a request context request_id stays null (nothing is manufactured)', async () => {
		await logError({ source: 'test.nocontext', operation: 'op', errorMessage: 'plain' });
		const [row] = await sql<any[]>`SELECT request_id, account_id FROM error_log WHERE source = 'test.nocontext'`;
		expect(row.request_id).toBeNull();
		expect(row.account_id).toBeNull();
	});
});

d('set temporary password + delete account', () => {
	it('sets a one-time password, forces reset, revokes sessions, never audits the secret', async () => {
		const a = await makeAccount();
		const u = await makeUser({ accountId: a.id, email: `tmp-${uniq()}@x.test` });
		await sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${u.id}, ${uniq()}, now() + interval '1 day')`;
		await expect(setTemporaryPassword({ actor }, a.id, u.id, 'no', u.email)).rejects.toBeInstanceOf(ActionError);
		await expect(setTemporaryPassword({ actor }, a.id, u.id, 'forgot password', 'wrong@x.test')).rejects.toBeInstanceOf(ActionError);
		sf.changed.mockResolvedValueOnce(true);
		const r = await setTemporaryPassword({ actor }, a.id, u.id, 'forgot password', u.email);
		// the user is told by email that an administrator reset their password — the email never carries the password
		expect(sf.changed).toHaveBeenCalledWith(u.email, 'admin', expect.objectContaining({ userId: u.id, accountId: a.id }));
		expect(sf.changed.mock.calls[0].join(' ')).not.toContain(r.tempPassword);
		expect(r.message).toMatch(/notification email was sent/);
		expect(r.tempPassword).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){2}$/);
		const [row] = await sql`SELECT password_hash, must_reset_password FROM users WHERE id = ${u.id}`;
		expect(row.must_reset_password).toBe(true);
		expect(row.password_hash).not.toContain(r.tempPassword);
		expect(await sql`SELECT 1 FROM sessions WHERE user_id = ${u.id}`).toHaveLength(0);
		const audit = await sql`SELECT metadata::text m FROM admin_audit_events WHERE action = 'user.password_reset.temporary' AND target_id = ${u.id}`;
		expect(audit).toHaveLength(1);
		expect(audit[0].m).not.toContain(r.tempPassword);
		const note = await sql`SELECT outcome FROM admin_audit_events WHERE action = 'user.password_reset.notification' AND target_id = ${u.id}`;
		expect(note).toMatchObject([{ outcome: 'success' }]);
	});
	it('still resets the password but tells the admin when the notification email could not be delivered', async () => {
		const a = await makeAccount();
		const u = await makeUser({ accountId: a.id, email: `tmp-${uniq()}@x.test` });
		sf.changed.mockResolvedValueOnce(false);
		const r = await setTemporaryPassword({ actor }, a.id, u.id, 'forgot password', u.email);
		expect(r.message).toMatch(/could NOT be sent/);
		const [row] = await sql`SELECT must_reset_password FROM users WHERE id = ${u.id}`;
		expect(row.must_reset_password).toBe(true);
		const note = await sql`SELECT outcome FROM admin_audit_events WHERE action = 'user.password_reset.notification' AND target_id = ${u.id}`;
		expect(note).toMatchObject([{ outcome: 'failure' }]);
	});
	it('refuses to touch a user from another account', async () => {
		const a = await makeAccount();
		const b = await makeAccount();
		const u = await makeUser({ accountId: b.id });
		await expect(setTemporaryPassword({ actor }, a.id, u.id, 'forgot password', u.email)).rejects.toMatchObject({ status: 404 });
	});
	it('deletes the account and every related record, keeps the audit trail', async () => {
		const a = await makeAccount({ name: `Doomed ${uniq()}`, sfdc: `001${uniq()}` });
		const u = await makeUser({ accountId: a.id, role: 'owner' });
		const s1 = await makeStore(a.id);
		await sql`INSERT INTO error_log (source, operation, account_id, user_id, error_message) VALUES ('t', 't', ${a.id}, ${u.id}, 'x')`;
		await sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${u.id}, ${uniq()}, now() + interval '1 day')`;
		await expect(deleteAccountCascade({ actor }, a.id, 'customer request', 'wrong name')).rejects.toBeInstanceOf(ActionError);
		await expect(deleteAccountCascade({ actor }, a.id, 'x', a.name)).rejects.toBeInstanceOf(ActionError);
		const r = await deleteAccountCascade({ actor }, a.id, 'customer request', a.name);
		expect(r.deleted).toMatchObject({ users: 1, stores: 1 });
		expect(await sql`SELECT 1 FROM accounts WHERE id = ${a.id}`).toHaveLength(0);
		expect(await sql`SELECT 1 FROM users WHERE id = ${u.id}`).toHaveLength(0);
		expect(await sql`SELECT 1 FROM stores WHERE id = ${s1}`).toHaveLength(0);
		expect(await sql`SELECT 1 FROM sessions WHERE user_id = ${u.id}`).toHaveLength(0);
		expect(await sql`SELECT 1 FROM error_log WHERE account_id = ${a.id}`).toHaveLength(0);
		expect(await sql`SELECT 1 FROM admin_audit_events WHERE action = 'account.delete' AND target_account_id = ${a.id}`).toHaveLength(1);
	});
	it('deleting an account never touches platform admins, even one with the same email as a customer in it', async () => {
		const a = await makeAccount({ name: `Staffed ${uniq()}` });
		const st = await makeStaff('platform_admin', { email: `same-${uniq()}@example.test` });
		await makeUser({ accountId: a.id, email: st.email, role: 'owner' });
		await deleteAccountCascade({ actor }, a.id, 'cleanup test', a.name);
		expect(await sql`SELECT 1 FROM accounts WHERE id = ${a.id}`).toHaveLength(0);
		expect(await sql`SELECT 1 FROM platform_staff WHERE user_id = ${st.id}`).toHaveLength(1);
	});
});
