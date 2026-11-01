/**
 * Connection pool for the read-only SQL reader role.
 *
 * - Configured ONLY by ADMIN_READONLY_DATABASE_URL. There is deliberately no
 *   fallback to DATABASE_URL: a missing/invalid reader config disables inline
 *   SQL, it never widens it.
 * - Before first use the connected role is inspected; if it looks privileged
 *   (superuser, createrole/createdb/bypassrls, or any SELECT on a base table
 *   in `public`) the pool is refused. This catches someone pointing the
 *   variable at the application's own login.
 */
import postgres, { type Sql } from 'postgres';
import { adminEnv } from '../env';

export class ReaderUnavailableError extends Error {}

let pool: Sql | null = null;
let verifiedAt = 0;

export function readerConfigured(): boolean {
	return !!adminEnv('ADMIN_READONLY_DATABASE_URL');
}

function getPool(): Sql {
	const url = adminEnv('ADMIN_READONLY_DATABASE_URL');
	if (!url) {
		throw new ReaderUnavailableError(
			'Inline SQL is not configured. Provision the reader role (db/admin/provision_sql_reader.sql) and set ADMIN_READONLY_DATABASE_URL.'
		);
	}
	if (url === adminEnv('DATABASE_URL')) {
		throw new ReaderUnavailableError('ADMIN_READONLY_DATABASE_URL must not equal DATABASE_URL.');
	}
	pool ??= postgres(url, {
		max: 4,
		idle_timeout: 30,
		connect_timeout: 5,
		prepare: false,
		connection: { application_name: 'admin-sql-reader' }
	});
	return pool;
}

export async function getVerifiedReader(): Promise<Sql> {
	const p = getPool();
	if (Date.now() - verifiedAt < 60_000) return p;
	try {
		const [r] = await p<
			{ who: string; bad_attrs: boolean; base_tables: number; reporting_ok: boolean }[]
		>`
			SELECT current_user::text AS who,
			       (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication
			        FROM pg_roles WHERE rolname = current_user) AS bad_attrs,
			       (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			        WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','f')
			          AND has_table_privilege(current_user, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')) AS base_tables,
			       has_schema_privilege(current_user, 'reporting', 'USAGE') AS reporting_ok
		`;
		if (r.bad_attrs) throw new ReaderUnavailableError('Reader role has elevated attributes; refusing to use it.');
		if (r.base_tables > 0) throw new ReaderUnavailableError('Reader role has access to base tables; refusing to use it.');
		if (!r.reporting_ok) throw new ReaderUnavailableError('Reader role cannot use the reporting schema (run the provisioning script).');
		verifiedAt = Date.now();
		return p;
	} catch (e) {
		verifiedAt = 0;
		if (e instanceof ReaderUnavailableError) throw e;
		throw new ReaderUnavailableError('Could not connect with the SQL reader role.');
	}
}

export async function closeReader(): Promise<void> {
	await pool?.end({ timeout: 2 });
	pool = null;
	verifiedAt = 0;
}
