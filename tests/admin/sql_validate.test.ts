import { describe, expect, it } from 'vitest';
import { SqlValidationError, summariseQuery, validateReadOnlySql } from '$lib/server/admin/data/sql_validate';

const ok = (q: string) => expect(() => validateReadOnlySql(q), q).not.toThrow();
const bad = (q: string) => expect(() => validateReadOnlySql(q), q).toThrow(SqlValidationError);

describe('SQL validator — accepted', () => {
	it('allows joins across customers on reporting views', () => {
		ok('select a.name, count(u.id) from accounts a left join users u on u.account_id = a.id group by a.name');
		ok('select * from reporting.users u join reporting.accounts a on a.id = u.account_id where u.email ilike \'%x%\'');
		ok('with t as (select account_id, count(*) c from stores group by 1) select * from t order by c desc limit 10');
		ok('select * from users union all select * from users');
		ok("select jsonb_build_object('a', 1), date_trunc('day', created_at), coalesce(email, '') from users;");
		ok('select (select count(*) from stores) as n');
		ok('select * from generate_series(1, 10)');
	});
	it('returns referenced views', () => {
		expect(validateReadOnlySql('select * from users u join reporting.stores s on s.account_id = u.account_id').tables.sort()).toEqual(['stores', 'users']);
	});
});

describe('SQL validator — rejected', () => {
	it('rejects writes, DDL, utility statements', () => {
		for (const q of [
			"insert into users(email) values ('x')",
			"update users set is_active = false",
			'delete from users',
			'drop table users',
			'truncate users',
			'create table t(a int)',
			'alter table users add column x int',
			"copy users to '/tmp/x'",
			'grant select on users to public',
			'set role postgres',
			'reset all',
			'begin',
			'commit',
			'vacuum',
			'explain analyze select 1',
			'call foo()',
			'do $$ begin end $$',
			"select * into newt from users",
			'listen x',
			'notify x',
			'lock table users'
		]) bad(q);
	});
	it('rejects stacked statements', () => {
		bad('select 1; select 2');
		bad('select 1; drop table users');
		bad('select 1 ; ; delete from users');
	});
	it('rejects write CTEs and recursion', () => {
		bad('with x as (delete from users returning *) select * from x');
		bad('with x as (insert into users(email) values (\'a\') returning *) select * from x');
		bad('with x as (select 1) delete from users');
		bad('with x as (update users set is_active=false returning *) select * from x');
		bad('with recursive r(n) as (select 1 union all select n+1 from r) select * from r');
	});
	it('rejects locking clauses', () => {
		bad('select * from users for update');
		bad('select * from users for share');
	});
	it('rejects non-reporting relations and catalogs', () => {
		bad('select * from pg_catalog.pg_authid');
		bad('select * from pg_authid');
		bad('select * from pg_shadow');
		bad('select * from pg_settings');
		bad('select * from pg_stat_activity');
		bad('select * from information_schema.tables');
		bad('select * from public.users');
		bad('select * from schema_that_is_not_there.users');
		bad('select * from some_unknown_table');
		bad('select * from admin_login_challenges');
		bad('select * from admin_rate_limits');
		bad('select * from reporting.not_a_view');
		bad('select (select count(*) from pg_authid)');
		bad('select * from users where id in (select id from pg_user)');
	});
	it('rejects CTE names that forge catalog names', () => {
		bad('select * from (with pg_authid as (select 1) select 1) a, pg_authid');
		bad('with pg_settings as (select 1 a) select * from pg_settings');
	});
	it('rejects functions outside the allowlist', () => {
		for (const q of [
			'select pg_sleep(10)',
			"select pg_read_file('/etc/passwd')",
			"select pg_read_binary_file('/etc/passwd')",
			"select lo_import('/etc/passwd')",
			"select current_setting('is_superuser')",
			"select set_config('role','postgres',false)",
			"select dblink('host=x','select 1')",
			'select pg_terminate_backend(1)',
			'select pg_cancel_backend(1)',
			'select version()',
			'select current_database()',
			"select query_to_xml('select 1', true, true, '')",
			"select repeat('x', 1000000000)",
			"select pg_ls_dir('.')",
			"select txid_current()",
			'select nextval(\'x\')',
			"select public.some_function()",
			"select pg_catalog.pg_sleep(1)",
			"select * from pg_sleep(1)",
			'select * from pg_ls_dir(\'.\')',
			"select lower(pg_read_file('x'))"
		]) bad(q);
	});
	it('rejects reg* casts', () => {
		bad("select 'pg_authid'::regclass");
		bad("select 'x'::regproc");
		bad("select 1::oid");
	});
	it('rejects empty, oversized and unparseable input', () => {
		bad('');
		bad('   ;  ');
		bad('select ' + '1,'.repeat(15000) + '1');
		bad('selec * frm users');
		bad('select * from users where');
	});
});

describe('audit summary', () => {
	it('strips literals', () => {
		const s = summariseQuery("select * from users where email = 'secret@x.com' and id = 42 and token = 'abc''def'");
		expect(s).not.toContain('secret@x.com');
		expect(s).not.toContain('abc');
		expect(s).not.toContain('42');
		expect(s).toContain("'?'");
	});
});
