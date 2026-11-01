/**
 * Exercises the REAL reader role (admin_sql_reader) against adversarial SQL,
 * both directly (bypassing the app validator, to prove the database itself
 * enforces the boundary) and through runReadOnlySql().
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeStaff, makeUser, uniq } from '../setup/db';
import { closeReader, ReaderUnavailableError } from '$lib/server/admin/data/reader_db';
import { runReadOnlySql, SqlBusyError, SqlExecutionError, MAX_ROWS } from '$lib/server/admin/data/sql_run';
import { SqlValidationError } from '$lib/server/admin/data/sql_validate';

const d = describe.skipIf(!hasDb);

let raw: ReturnType<typeof postgres>;
beforeAll(() => {
	if (hasDb) raw = postgres(process.env.ADMIN_READONLY_DATABASE_URL!, { max: 2, onnotice: () => {}, prepare: false });
});
afterAll(async () => { await raw?.end({ timeout: 2 }); await closeReader(); });

const denied = async (q: string) => {
	await expect(raw.unsafe(q), q).rejects.toThrow();
};

d('reader role — enforced by the database, not the validator', () => {
	it('is not privileged and owns nothing', async () => {
		const [r] = await raw`SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolreplication, rolinherit FROM pg_roles WHERE rolname = current_user`;
		expect(r).toEqual({ rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolreplication: false, rolinherit: false });
		const members = await raw`SELECT count(*)::int AS n FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
		expect(members[0].n).toBe(0);
		const owned = await raw`SELECT count(*)::int AS n FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)`;
		expect(owned[0].n).toBe(0);
	});
	it('can read reporting views via its search_path and join across customers', async () => {
		const a1 = await makeAccount(); const a2 = await makeAccount();
		await makeUser({ accountId: a1.id }); await makeUser({ accountId: a2.id });
		const rows = await raw`SELECT a.id, count(u.id)::int AS n FROM accounts a JOIN users u ON u.account_id = a.id WHERE a.id IN (${a1.id}, ${a2.id}) GROUP BY a.id`;
		expect(rows).toHaveLength(2);
	});
	it('has no access to base tables (no SELECT on public.*)', async () => {
		for (const t of ['users', 'sessions', 'admin_sessions', 'admin_mfa_credentials', 'admin_recovery_codes', 'password_reset_tokens', 'api_keys', 'stores', 'error_log', 'admin_login_challenges', 'oauth_accounts'])
			await denied(`SELECT * FROM public.${t}`);
	});
	it('raw secret columns do not exist in any reporting view', async () => {
		const cols = (await raw`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'reporting'`).map((c) => c.column_name as string);
		const forbidden = ['password_hash', 'token_hash', 'key_hash', 'secret_encrypted', 'code_hash', 'spapi_refresh_token', 'spapi_access_token', 'access_token', 'refresh_token', 'invite_token', 'provider_uid', 'state', 'payload', 'data', 'error_message', 'stack', 'context', 'event_data', 'storage_path', 's3_key', 's3_bucket', 'ip_address', 'user_agent', 'question', 'answer', 'last_used_step', 'granted_by_ref', 'spapi_callback_params', 'email_body'];
		expect(cols.filter((c) => forbidden.includes(c))).toEqual([]);
		// generic pattern, with the reviewed benign names allow-listed
		const benign = new Set(['must_reset_password', 'invite_sent_at', 'invite_accepted_at', 'spapi_access_token_expires_at', 'billing_state']);
		const suspicious = cols.filter((c) => /password|token|secret|hash|private|credential/i.test(c) && !benign.has(c));
		expect(suspicious).toEqual([]);
	});
	it('blocks writes, DDL, stacked statements, write CTEs', async () => {
		await denied(`INSERT INTO reporting.users(email) VALUES ('x')`);
		await denied(`UPDATE reporting.users SET is_active = false`);
		await denied(`DELETE FROM reporting.users`);
		await denied(`TRUNCATE reporting.users`);
		await denied(`CREATE TABLE reporting.x(a int)`);
		await denied(`CREATE TABLE public.x(a int)`);
		await denied(`CREATE TEMP TABLE t(a int)`);
		await denied(`CREATE SCHEMA evil`);
		await denied(`CREATE VIEW reporting.v AS SELECT 1`);
		await denied(`CREATE FUNCTION public.f() RETURNS int AS 'select 1' LANGUAGE sql`);
		await denied(`DROP VIEW reporting.users`);
		await denied(`ALTER VIEW reporting.users RENAME TO u2`);
		await denied(`GRANT SELECT ON reporting.users TO PUBLIC`);
		await denied(`COPY reporting.users TO '/tmp/leak'`);
		await denied(`COPY reporting.users TO PROGRAM 'id'`);
		await denied(`WITH x AS (DELETE FROM reporting.users RETURNING 1) SELECT * FROM x`);
		await denied(`WITH x AS (INSERT INTO public.users(email) VALUES ('q') RETURNING 1) SELECT * FROM x`);
		await denied(`SELECT 1; DELETE FROM reporting.users`);
		await denied(`SELECT * INTO public.copy FROM reporting.users`);
		await denied(`SELECT * INTO TEMP t2 FROM reporting.users`);
	});
	it('blocks privilege escalation', async () => {
		await denied(`SET ROLE postgres`);
		await denied(`SET SESSION AUTHORIZATION postgres`);
		await denied(`ALTER ROLE admin_sql_reader SUPERUSER`);
		await denied(`CREATE ROLE evil SUPERUSER`);
		await denied(`GRANT postgres TO admin_sql_reader`);
		await denied(`SELECT set_config('role', 'postgres', false)`.replace('set_config', 'set_config') + '; SELECT * FROM public.users');
	});
	it('blocks file/network/admin functions and protected catalogs', async () => {
		await denied(`SELECT pg_read_file('/etc/passwd')`);
		await denied(`SELECT pg_read_binary_file('/etc/hosts')`);
		await denied(`SELECT * FROM pg_ls_dir('.')`);
		await denied(`SELECT lo_import('/etc/passwd')`);
		await denied(`SELECT pg_reload_conf()`);
		await denied(`SELECT pg_switch_wal()`);
		await denied(`SELECT * FROM pg_authid`);
		await denied(`SELECT * FROM pg_shadow`);
		await denied(`SELECT * FROM pg_user_mappings WHERE umoptions IS NOT NULL AND false UNION SELECT * FROM pg_authid`);
		await denied(`SELECT dblink_connect('host=localhost')`); // extension absent
		await denied(`CREATE EXTENSION dblink`);
		await denied(`ALTER SYSTEM SET log_statement = 'all'`);
		await denied(`CREATE SERVER s FOREIGN DATA WRAPPER postgres_fdw`);
		await denied(`LOAD 'x'`);
	});
	it('cannot signal or terminate other roles\' sessions', async () => {
		const su = postgres(process.env.TEST_SUPERUSER_DATABASE_URL!, { max: 1, onnotice: () => {} });
		try {
			const [{ pid }] = await su`SELECT pg_backend_pid() AS pid`;
			await expect(raw`SELECT pg_terminate_backend(${pid})`).rejects.toThrow(/permission|member/i);
			await expect(raw`SELECT pg_cancel_backend(${pid})`).rejects.toThrow(/permission|member/i);
		} finally { await su.end({ timeout: 1 }); }
	});
	it('anonymous code blocks (DO) can only do what the role itself can do', async () => {
		// plpgsql DO is granted to PUBLIC by default; it must still run with the reader\'s (non-)privileges.
		await denied(`DO $$ BEGIN INSERT INTO public.users(email) VALUES ('do-block@x.test'); END $$`);
		await denied(`DO $$ BEGIN PERFORM * FROM public.users; END $$`);
		await denied(`DO $$ BEGIN EXECUTE 'SET ROLE postgres'; END $$`);
		await denied(`DO $$ BEGIN EXECUTE 'CREATE TEMP TABLE z(a int)'; END $$`);
		await denied(`DO $$ BEGIN PERFORM pg_read_file('/etc/passwd'); END $$`);
	});
	it('settings and activity do not reveal secrets to a non-superuser', async () => {
		// Superuser-only settings (paths, files) are NULL for this role.
		const s = await raw`SELECT name, setting FROM pg_settings WHERE name IN ('data_directory','hba_file','config_file','ident_file')`;
		for (const r of s) expect(r.setting, r.name as string).toBeNull();
		// Nothing credential-like is visible in any setting value.
		const cred = await raw`SELECT name FROM pg_settings WHERE name ~* '(password|secret|token)' AND setting IS NOT NULL AND setting <> '' AND setting NOT IN ('off','on','0') AND name NOT IN ('password_encryption', 'scram_iterations')`;
		expect(cred).toHaveLength(0);
		const act = await raw`SELECT query FROM pg_stat_activity WHERE usename IS DISTINCT FROM current_user AND query <> ''`;
		for (const r of act) expect(r.query).toBe('<insufficient privilege>');
	});
	it('transaction READ ONLY and role GUCs are applied by default', async () => {
		const [r] = await raw`SHOW default_transaction_read_only`;
		expect(r.default_transaction_read_only).toBe('on');
		const [sp] = await raw`SHOW search_path`;
		expect(sp.search_path).toBe('reporting');
	});
});

d('runReadOnlySql', () => {
	// admin_sql_active has an FK to users, so use real (staff) users as the acting administrator.
	const pool: string[] = [];
	beforeAll(async () => { for (let i = 0; i < 12; i++) pool.push((await makeStaff('platform_admin')).id); });
	const uid = () => pool.pop() ?? crypto.randomUUID();

	it('joins permitted records across customers and labels the scope', async () => {
		const a1 = await makeAccount({ name: `Join A ${uniq()}` }); const a2 = await makeAccount({ name: `Join B ${uniq()}` });
		await makeUser({ accountId: a1.id }); await makeUser({ accountId: a2.id });
		const r = await runReadOnlySql({
			userId: uid(),
			query: `select a.name, count(u.id) as users from accounts a join users u on u.account_id = a.id where a.id in ('${a1.id}', '${a2.id}') group by a.name order by a.name`
		});
		expect(r.scope).toBe('All customers');
		expect(r.rowCount).toBe(2);
		expect(r.columns.map((c) => c.name)).toEqual(['name', 'users']);
		expect(r.columns[1].type).toBe('bigint');
		expect(r.rows[0].users).toBe('1'); // bigint preserved as string, no precision loss
		expect(r.truncated).toBe(false);
	});
	it('serialises types safely (null, timestamptz, jsonb, big numerics)', async () => {
		const r = await runReadOnlySql({ userId: uid(), query: `select null::text as n, now() as ts, jsonb_build_object('a', 1) as j, 12345678901234567890.123456789::numeric as big, 9007199254740993::bigint as b` });
		const row = r.rows[0];
		expect(row.n).toBeNull();
		expect(typeof row.ts).toBe('string');
		expect(row.j).toEqual({ a: 1 });
		expect(row.big).toBe('12345678901234567890.123456789');
		expect(row.b).toBe('9007199254740993');
	});
	it('stops fetching at the displayed-row cap and the hard maximum', async () => {
		const r1 = await runReadOnlySql({ userId: uid(), query: 'select s from generate_series(1, 5000) s' });
		expect(r1.rowCount).toBe(500);
		expect(r1.truncated).toBe(true);
		expect(r1.truncatedBy).toBe('rows');
		const r2 = await runReadOnlySql({ userId: uid(), query: 'select s from generate_series(1, 5000) s', maxRows: 999999 });
		expect(r2.rowCount).toBe(MAX_ROWS);
		const r3 = await runReadOnlySql({ userId: uid(), query: 'select s from generate_series(1, 10) s' });
		expect(r3.truncated).toBe(false);
	});
	it('enforces the 2 MB response bound while fetching', async () => {
		const r = await runReadOnlySql({
			userId: uid(), maxRows: 1000,
			query: `select s, (select string_agg(g::text, ',') from generate_series(1, 3000) g) as big from generate_series(1, 1000) s`
		});
		expect(r.truncatedBy).toBe('bytes');
		expect(r.rowCount).toBeLessThan(1000);
		expect(JSON.stringify(r.rows).length).toBeLessThan(2.2 * 1024 * 1024);
	});
	it('times out long statements (5 s) and releases the connection', async () => {
		const t0 = Date.now();
		await expect(runReadOnlySql({ userId: uid(), query: 'select count(*) from generate_series(1, 100000000000)' })).rejects.toThrow(/timeout|cancel/i);
		expect(Date.now() - t0).toBeLessThan(9000);
		const idle = await sql`SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'admin-sql-reader' AND state IN ('idle in transaction', 'active')`;
		expect(idle[0].n).toBe(0);
	}, 20_000);
	it('allows one active query per administrator across replicas', async () => {
		const me = uid();
		const slow = runReadOnlySql({ userId: me, query: 'select count(*) from generate_series(1, 100000000000)' }).catch((e) => e);
		await new Promise((r) => setTimeout(r, 400));
		await expect(runReadOnlySql({ userId: me, query: 'select 1' })).rejects.toBeInstanceOf(SqlBusyError);
		// a different administrator is unaffected
		const other = await runReadOnlySql({ userId: uid(), query: 'select 1 as x' });
		expect(other.rowCount).toBe(1);
		await slow;
		// lock released afterwards
		expect((await runReadOnlySql({ userId: me, query: 'select 1 as x' })).rowCount).toBe(1);
	}, 20_000);
	it('releases the lock and connection after a failing query', async () => {
		const me = uid();
		await expect(runReadOnlySql({ userId: me, query: 'select 1/0' })).rejects.toBeInstanceOf(SqlExecutionError);
		await expect(runReadOnlySql({ userId: me, query: 'select * from users where nope = 1' })).rejects.toBeInstanceOf(SqlExecutionError);
		expect((await runReadOnlySql({ userId: me, query: 'select 1 as ok' })).rowCount).toBe(1);
		const [a] = await sql`SELECT 1 FROM admin_sql_active WHERE user_id = ${me}`;
		expect(a).toBeUndefined();
	});
	it('cancels on client abort', async () => {
		const ac = new AbortController();
		const p = runReadOnlySql({ userId: uid(), query: 'select count(*) from generate_series(1, 100000000000)', signal: ac.signal }).catch((e) => e);
		setTimeout(() => ac.abort(), 300);
		const t0 = Date.now();
		const e = await p;
		expect(e).toBeInstanceOf(Error);
		expect(Date.now() - t0).toBeLessThan(4000);
	}, 15_000);
	it('validator rejects before touching the database; never executes writes', async () => {
		await expect(runReadOnlySql({ userId: uid(), query: 'delete from users' })).rejects.toBeInstanceOf(SqlValidationError);
		await expect(runReadOnlySql({ userId: uid(), query: 'select pg_read_file($$/etc/passwd$$)' })).rejects.toBeInstanceOf(SqlValidationError);
	});
	it('does not leak connection strings in errors', async () => {
		const e: Error = await runReadOnlySql({ userId: uid(), query: 'select * from users where nope = 1' }).catch((x) => x);
		expect(e.message).not.toMatch(/postgres(ql)?:\/\//);
		expect(e.message).not.toContain(process.env.ADMIN_READONLY_DATABASE_URL!.split('@')[0]);
	});
});

d('reader configuration — never falls back to the privileged connection', () => {
	it('missing ADMIN_READONLY_DATABASE_URL → unavailable (and no query runs)', async () => {
		const saved = process.env.ADMIN_READONLY_DATABASE_URL;
		await closeReader();
		delete process.env.ADMIN_READONLY_DATABASE_URL;
		try {
			await expect(runReadOnlySql({ userId: crypto.randomUUID(), query: 'select 1' })).rejects.toBeInstanceOf(ReaderUnavailableError);
		} finally { process.env.ADMIN_READONLY_DATABASE_URL = saved; await closeReader(); }
	});
	it('refuses a reader URL equal to DATABASE_URL', async () => {
		const saved = process.env.ADMIN_READONLY_DATABASE_URL;
		await closeReader();
		process.env.ADMIN_READONLY_DATABASE_URL = process.env.DATABASE_URL;
		try {
			await expect(runReadOnlySql({ userId: crypto.randomUUID(), query: 'select 1' })).rejects.toBeInstanceOf(ReaderUnavailableError);
		} finally { process.env.ADMIN_READONLY_DATABASE_URL = saved; await closeReader(); }
	});
	it('refuses a privileged role even if configured as the reader (role inspection)', async () => {
		const saved = process.env.ADMIN_READONLY_DATABASE_URL;
		await closeReader();
		process.env.ADMIN_READONLY_DATABASE_URL = process.env.DATABASE_URL + '?application_name=sneaky';
		try {
			await expect(runReadOnlySql({ userId: crypto.randomUUID(), query: 'select 1' })).rejects.toThrow(/refusing|reporting|must not equal/i);
		} finally { process.env.ADMIN_READONLY_DATABASE_URL = saved; await closeReader(); }
	});
	it('an unreachable reader gives a clean error', async () => {
		const saved = process.env.ADMIN_READONLY_DATABASE_URL;
		await closeReader();
		process.env.ADMIN_READONLY_DATABASE_URL = 'postgresql://nobody:nope@127.0.0.1:1/none';
		try {
			const e: Error = await runReadOnlySql({ userId: crypto.randomUUID(), query: 'select 1' }).catch((x) => x);
			expect(e).toBeInstanceOf(ReaderUnavailableError);
			expect(e.message).not.toContain('nope');
		} finally { process.env.ADMIN_READONLY_DATABASE_URL = saved; await closeReader(); }
	});
});
