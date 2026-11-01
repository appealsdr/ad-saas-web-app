/**
 * Creates a disposable database for the whole test run, applies every
 * migration, provisions the real SQL reader role, and exports connection
 * strings through process.env. Nothing here touches DATABASE_URL.
 *
 *   TEST_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres npm test
 *
 * TEST_PG_URL must be a superuser connection to a maintenance database. If it is
 * not set, DB-backed tests are skipped (unit tests still run).
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import postgres from 'postgres';

const root = join(import.meta.dirname, '..', '..');
let dbName = '';
let adminUrl = '';

function withDb(url: string, db: string, user?: string, password?: string): string {
	const u = new URL(url);
	u.pathname = `/${db}`;
	if (user) {
		u.username = user;
		u.password = password ?? '';
	}
	return u.toString();
}

export async function setup() {
	process.env.ADMIN_MFA_ENCRYPTION_KEY = '11'.repeat(32);
	adminUrl = process.env.TEST_PG_URL ?? '';
	if (!adminUrl) {
		console.warn('\n[tests] TEST_PG_URL not set — database-backed tests will be skipped.\n');
		process.env.TEST_DB_AVAILABLE = '';
		return;
	}
	dbName = `admin_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
	const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
	await admin.unsafe(`CREATE DATABASE ${dbName}`);
	await admin.end();

	const dbUrl = withDb(adminUrl, dbName);
	const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
	const dir = join(root, 'db', 'migrations');
	for (const f of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
		await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
	}
	await sql.end();

	const readerPassword = 'reader-test-pw-' + Math.floor(Math.random() * 1e9);
	execFileSync(
		process.env.PSQL_BIN ?? 'psql',
		['-q', '-v', 'ON_ERROR_STOP=1', '-v', `reader_password=${readerPassword}`, '-d', dbUrl, '-f', join(root, 'db', 'admin', 'provision_sql_reader.sql')],
		{ stdio: ['ignore', 'ignore', 'inherit'] }
	);

	process.env.TEST_DB_AVAILABLE = '1';
	process.env.DATABASE_URL = dbUrl;
	process.env.ADMIN_READONLY_DATABASE_URL = withDb(adminUrl, dbName, 'admin_sql_reader', readerPassword);
	process.env.TEST_SUPERUSER_DATABASE_URL = dbUrl;
}

export async function teardown() {
	if (!dbName) return;
	const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
	await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
	await admin.end();
}
