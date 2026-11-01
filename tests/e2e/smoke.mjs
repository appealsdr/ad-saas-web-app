#!/usr/bin/env node
/**
 * End-to-end smoke test against the BUILT server (npm run build first).
 *
 *   TEST_PG_URL=postgresql://postgres@127.0.0.1:5432/postgres node tests/e2e/smoke.mjs
 *
 * Creates a disposable database, applies migrations, provisions the reader role,
 * seeds data, starts `node build` on a random port, and drives real HTTP:
 * anonymous / customer / viewer / admin access, login + MFA, CSRF, tampering,
 * SQL runner, logout/revocation. Nothing touches DATABASE_URL.
 */
import { spawn, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import postgres from 'postgres';
import { generateSync } from 'otplib';

const root = join(import.meta.dirname, '..', '..');
const PG = process.env.TEST_PG_URL;
if (!PG) { console.error('TEST_PG_URL is required'); process.exit(2); }
const dbName = `admin_e2e_${Date.now()}`;
const port = 4200 + Math.floor(Math.random() * 500);
const base = `http://localhost:${port}`;
const withDb = (db, user, pw) => { const u = new URL(PG); u.pathname = `/${db}`; if (user) { u.username = user; u.password = pw; } return u.toString(); };

let passed = 0, failed = 0;
const check = (name, cond, extra = '') => { if (cond) { passed++; console.log(`  ✓ ${name}`); } else { failed++; console.log(`  ✗ ${name} ${extra}`); } };

const hash = (pw) => { const salt = randomBytes(16); return `scrypt$16384$8$1$${salt.toString('hex')}$${scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 }).toString('hex')}`; };

// ── tiny cookie-jar client ──────────────────────────────────────────────
class Client {
	jar = new Map();
	async req(path, { method = 'GET', form, json, headers = {}, origin = base } = {}) {
		const h = { accept: 'text/html', ...headers };
		if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
		let body;
		if (form) { body = new URLSearchParams(form).toString(); h['content-type'] = 'application/x-www-form-urlencoded'; }
		if (json) { body = JSON.stringify(json); h['content-type'] = 'application/json'; h.accept = 'application/json'; }
		if (method !== 'GET' && origin) h.origin = origin;
		const res = await fetch(base + path, { method, headers: h, body, redirect: 'manual' });
		for (const c of res.headers.getSetCookie?.() ?? []) {
			const [kv] = c.split(';'); const i = kv.indexOf('=');
			const k = kv.slice(0, i), v = kv.slice(i + 1);
			if (/max-age=0|expires=thu, 01 jan 1970/i.test(c) || v === '') this.jar.delete(k); else this.jar.set(k, v);
		}
		return { status: res.status, headers: res.headers, location: res.headers.get('location'), text: await res.text() };
	}
}

async function main() {
	// ── database ────────────────────────────────────────────────────────
	const admin = postgres(PG, { max: 1, onnotice: () => {} });
	await admin.unsafe(`CREATE DATABASE ${dbName}`); await admin.end();
	const dbUrl = withDb(dbName);
	const sql = postgres(dbUrl, { max: 2, onnotice: () => {} });
	for (const f of readdirSync(join(root, 'db/migrations')).filter((f) => f.endsWith('.sql')).sort()) await sql.unsafe(readFileSync(join(root, 'db/migrations', f), 'utf8'));
	const readerPw = 'e2e-reader-' + randomBytes(6).toString('hex');
	execFileSync(process.env.PSQL_BIN ?? 'psql', ['-q', '-v', 'ON_ERROR_STOP=1', '-v', `reader_password=${readerPw}`, '-d', dbUrl, '-f', join(root, 'db/admin/provision_sql_reader.sql')], { stdio: ['ignore', 'ignore', 'inherit'] });

	const PW = 'E2e-Correct-Horse-9';
	const mkUser = async (email, role = 'member', accountId = null) => (await sql`INSERT INTO users (email, display_name, password_hash, role, account_id) VALUES (${email}, ${email}, ${hash(PW)}, ${role}, ${accountId}) RETURNING id`)[0].id;
	const [A] = await sql`INSERT INTO accounts (name, email, onboarding_completed) VALUES ('Acme E2E', 'a@acme.test', true) RETURNING id`;
	const [B] = await sql`INSERT INTO accounts (name, email, onboarding_completed, sfdc_account_id) VALUES ('Bravo E2E', null, false, '001BRAVO') RETURNING id`;
	const ownerA = await mkUser('owner-a@acme.test', 'owner', A.id);
	const adminA = await mkUser('admin-a@acme.test', 'admin', A.id);
	const ownerB = await mkUser('owner-b@bravo.test', 'owner', B.id);
	await mkUser('orphan@nowhere.test');
	const [sA] = await sql`INSERT INTO stores (account_id, name) VALUES (${A.id}, 'Acme Store') RETURNING id`;
	const [sB] = await sql`INSERT INTO stores (account_id, name) VALUES (${B.id}, 'Bravo Store') RETURNING id`;
	const [docB] = await sql`INSERT INTO store_documents (store_id, original_name, storage_path, size_bytes) VALUES (${sB.id}, 'bravo-secret.pdf', 'x', 1) RETURNING id`;
	await sql`INSERT INTO error_log (source, operation, error_message, context, account_id) VALUES ('e2e', 'seed', 'seeded error password=hunter2', ${sql.json({ api_key: 'k-123' })}, ${A.id})`;

	const mkStaff = async (email, role) => (await sql`INSERT INTO platform_staff (role, email, display_name, password_hash) VALUES (${role}, ${email}, ${email}, ${hash(PW)}) RETURNING user_id`)[0].user_id;
	const staffAdmin = await mkStaff('staff-admin@co.test', 'platform_admin');
	const staffViewer = await mkStaff('staff-viewer@co.test', 'platform_viewer');

	// ── server ──────────────────────────────────────────────────────────
	const server = spawn('node', ['build'], {
		cwd: root,
		env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: base, NODE_ENV: 'production', DATABASE_URL: dbUrl,
			ADMIN_READONLY_DATABASE_URL: withDb(dbName, 'admin_sql_reader', readerPw), ADMIN_MFA_ENCRYPTION_KEY: '7a'.repeat(32) },
		stdio: ['ignore', 'pipe', 'pipe']
	});
	let serverLog = ''; server.stdout.on('data', (d) => (serverLog += d)); server.stderr.on('data', (d) => (serverLog += d));
	for (let i = 0; i < 50; i++) { try { await fetch(base + '/login'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

	try {
		console.log('\nanonymous');
		const anon = new Client();
		let r = await anon.req('/admin/accounts');
		check('GET /admin/accounts → redirect to /admin/login', r.status === 303 && r.location.startsWith('/admin/login?next='), `${r.status} ${r.location}`);
		r = await anon.req('/admin');
		check('GET /admin → login', r.status === 303 && r.location.startsWith('/admin/login'));
		r = await anon.req('/admin/data/query', { method: 'POST', json: { query: 'select 1' } });
		check('POST /admin/data/query anonymous → 401', r.status === 401, String(r.status));
		r = await anon.req('/admin/accounts/' + A.id + '/users?/manage', { method: 'POST', form: { userId: ownerA, action: 'suspend', reason: 'hacking!', confirm: 'owner-a@acme.test' } });
		check('POST admin form action anonymous → 401', r.status === 401, String(r.status));
		r = await anon.req('/admin/accounts/' + A.id + '/documents/store/' + docB.id + '/download');
		check('document download anonymous → login', r.status === 303);
		for (const p of ['/api/aws/diagnostic', '/api/sfdc/diagnostic/pricebook']) { r = await anon.req(p); check(`${p} anonymous → login redirect`, r.status === 303 && r.location.startsWith('/admin/login'), String(r.status)); }
		r = await anon.req('/admin/login');
		check('login page: no-store + frame denial', /no-store/.test(r.headers.get('cache-control') ?? '') && r.headers.get('x-frame-options') === 'DENY');
		check('login page carries a request id', !!r.headers.get('x-request-id'));
		r = await anon.req('/admin/logout');
		check('GET /admin/logout is not a state change', r.status === 405 || r.status === 404, String(r.status));

		console.log('\ncustomer sessions (owner/admin/member roles) cannot reach admin');
		for (const [who, email] of [['owner', 'owner-a@acme.test'], ['admin', 'admin-a@acme.test']]) {
			const c = new Client();
			r = await c.req('/login?/login', { method: 'POST', form: { email, password: PW } });
			check(`${who}: customer login still works`, r.status === 303 && c.jar.has('session'), `${r.status} ${r.location}`);
			r = await c.req('/admin/accounts');
			check(`${who}: /admin/accounts → login`, r.status === 303 && r.location.startsWith('/admin/login'));
			r = await c.req('/admin/data/query', { method: 'POST', json: { query: 'select 1' } });
			check(`${who}: SQL endpoint → 401`, r.status === 401);
			r = await c.req('/admin/staff');
			check(`${who}: /admin/staff → login`, r.status === 303);
			r = await c.req('/api/aws/diagnostic');
			check(`${who}: AWS diagnostic → not served`, r.status === 303);
			r = await c.req('/dashboard');
			check(`${who}: customer /dashboard unaffected`, r.status === 200, String(r.status));
			// customer cookie must not be accepted as an admin session even if renamed
			const fake = new Client(); fake.jar.set('admin_session', c.jar.get('session'));
			r = await fake.req('/admin/accounts');
			check(`${who}: customer token as admin_session → login`, r.status === 303 && r.location.startsWith('/admin/login'));
		}
		r = await anon.req('/dashboard');
		check('customer area still requires customer login', r.status === 303 && r.location.startsWith('/login'));

		console.log('\nstaff login: password → MFA → admin');
		const adm = new Client();
		r = await adm.req('/admin/login', { method: 'POST', form: { email: 'staff-admin@co.test', password: 'wrong-password-123' } });
		check('wrong password → generic 401', r.status === 401 && /Invalid email or password\./.test(r.text));
		r = await adm.req('/admin/login', { method: 'POST', form: { email: 'owner-a@acme.test', password: PW } });
		check('customer owner (non-staff) → same generic 401', r.status === 401 && /Invalid email or password\./.test(r.text));
		r = await adm.req('/admin/login', { method: 'POST', form: { email: 'staff-admin@co.test', password: PW, next: '/admin/logs' }, origin: 'https://evil.example' });
		check('CSRF: cross-origin login POST rejected', r.status === 403, String(r.status));
		r = await adm.req('/admin/login', { method: 'POST', form: { email: 'staff-admin@co.test', password: PW, next: '/admin/logs' } });
		check('correct password → /admin/mfa (no session yet)', r.status === 303 && r.location === '/admin/mfa' && adm.jar.has('admin_challenge') && !adm.jar.has('admin_session'));
		r = await adm.req('/admin/accounts');
		check('challenge cookie grants no data access', r.status === 303 && r.location.startsWith('/admin/login'));
		r = await adm.req('/admin/mfa');
		const secret = /Key: ([A-Z2-7]+)/.exec(r.text)?.[1];
		check('MFA enrollment shows QR + key (first login)', r.status === 200 && !!secret && r.text.includes('<svg'));
		r = await adm.req('/admin/mfa', { method: 'POST', form: { code: '000000' } });
		check('bad TOTP rejected', r.status === 401);
		r = await adm.req('/admin/mfa', { method: 'POST', form: { code: generateSync({ secret, strategy: 'totp' }) } });
		const codes = /[0-9a-f]{6}-[0-9a-f]{6}/g;
		const codes0 = [...new Set(r.text.match(codes) ?? [])]; check('enrollment confirmed → session cookie + one-time recovery codes', r.status === 200 && adm.jar.has('admin_session') && codes0.length >= 10, `${r.status}`);
		check('challenge cookie cleared', !adm.jar.has('admin_challenge'));
		r = await adm.req('/admin');
		check('/admin → /admin/accounts (account-first landing)', r.status === 303 && r.location === '/admin/accounts');
		r = await adm.req('/admin/accounts');
		check('accounts list shows all accounts incl. incomplete/no-owner/unlinked', r.status === 200 && r.text.includes('Acme E2E') && r.text.includes('Bravo E2E') && r.text.includes('Incomplete'));
		check('admin pages are not cacheable', /no-store/.test(r.headers.get('cache-control') ?? ''));
		r = await adm.req('/admin/accounts?q=bravo&onboarding=incomplete');
		check('search + filter', r.status === 200 && r.text.includes('Bravo E2E') && !r.text.includes('Acme E2E'));
		r = await adm.req('/admin/users?filter=no_account');
		check('global users include users with no account', r.status === 200 && r.text.includes('orphan@nowhere.test') && !r.text.includes('owner-a@acme.test'));

		console.log('\naccount workspaces');
		for (const tab of ['', '/users', '/stores', '/services', '/billing', '/documents', '/integrations', '/logs', '/data']) {
			r = await adm.req(`/admin/accounts/${A.id}${tab}`);
			check(`account A ${tab || '/overview'} renders`, r.status === 200 && r.text.includes('Admin view · Acme E2E'), String(r.status));
		}
		r = await adm.req(`/admin/accounts/${A.id}/users`);
		check('A users tab shows A users only', r.text.includes('owner-a@acme.test') && r.text.includes('admin-a@acme.test') && !r.text.includes('owner-b@bravo.test'));
		r = await adm.req(`/admin/accounts/${B.id}/users`);
		check('B users tab shows B users only', r.text.includes('owner-b@bravo.test') && !r.text.includes('owner-a@acme.test'));
		r = await adm.req(`/admin/accounts/${A.id}/stores`);
		check('A stores tab: only A store', r.text.includes('Acme Store') && !r.text.includes('Bravo Store'));
		r = await adm.req(`/admin/accounts/${A.id}/logs`);
		check('A logs tab shows A\'s attributed error, redacted', r.text.includes('seeded error') && !r.text.includes('hunter2') && !r.text.includes('k-123'));
		r = await adm.req(`/admin/accounts/${B.id}/logs`);
		check('B logs tab does not show A\'s record', !r.text.includes('seeded error'));
		r = await adm.req(`/admin/accounts/${A.id}/documents/store/${docB.id}/download`);
		check('tampered document id (belongs to B) under A → 404', r.status === 404, String(r.status));
		r = await adm.req(`/admin/accounts/${B.id}/documents/store/${docB.id}/download`);
		check('correct account → audited download attempt proceeds (404 only because no file exists)', r.status === 404 || r.status === 302 || r.status === 200);
		const [dl] = await sql`SELECT 1 FROM admin_audit_events WHERE action = 'document.download' AND target_id = ${docB.id}`;
		check('document download recorded in audit', !!dl);
		r = await adm.req('/admin/accounts/not-a-uuid');
		check('invalid account id → 404', r.status === 404);
		r = await adm.req('/admin/accounts/00000000-0000-4000-8000-000000000000');
		check('unknown account id → 404', r.status === 404);
		const [me] = await sql`SELECT count(*)::int AS n FROM users WHERE id = ${staffAdmin}`;
		check('admin is not a customer user (standalone identity)', me.n === 0);

		console.log('\nmanagement actions through the UI layer');
		r = await adm.req(`/admin/accounts/${A.id}/users?/manage`, { method: 'POST', form: { userId: ownerB, action: 'suspend', reason: 'tamper attempt', confirm: 'owner-b@bravo.test' } });
		const [ob] = await sql`SELECT is_active FROM users WHERE id = ${ownerB}`;
		check('user from another account cannot be managed via this workspace', ob.is_active === true && /not found/i.test(r.text), String(r.status));
		r = await adm.req(`/admin/accounts/${A.id}/users?/manage`, { method: 'POST', form: { userId: adminA, action: 'suspend', reason: 'e2e suspend test', confirm: 'admin-a@acme.test' } });
		const [aa] = await sql`SELECT is_active FROM users WHERE id = ${adminA}`;
		check('platform_admin can suspend a customer user (reason + confirmation)', aa.is_active === false);
		await adm.req(`/admin/accounts/${A.id}/users?/manage`, { method: 'POST', form: { userId: adminA, action: 'reactivate', reason: 'e2e reactivate', confirm: 'admin-a@acme.test' } });

		console.log('\ndata explorer + SQL');
		r = await adm.req('/admin/data');
		check('data explorer lists tables incl. security tables as metadata', r.status === 200 && r.text.includes('admin_login_challenges') && r.text.includes('Global') === false || r.text.includes('All customers'));
		r = await adm.req('/admin/data?table=users');
		check('users projection has no password_hash column data', r.status === 200 && !r.text.includes('scrypt$'));
		r = await adm.req('/admin/data?table=admin_login_challenges');
		check('metadata-only table explains restriction', r.status === 200 && /Metadata only/.test(r.text));
		r = await adm.req('/admin/data/query', { method: 'POST', json: { query: `select a.name, count(u.id) users from accounts a join users u on u.account_id = a.id group by a.name order by a.name` } });
		let body = JSON.parse(r.text);
		check('SQL joins across customers', r.status === 200 && body.scope === 'All customers' && body.rows.length === 2 && body.columns.length === 2, r.text.slice(0, 120));
		for (const [label, q] of [['DELETE', 'delete from users'], ['stacked', 'select 1; drop table users'], ['write CTE', 'with x as (delete from users returning 1) select * from x'], ['password_hash', 'select password_hash from public.users'], ['catalog', 'select * from pg_authid'], ['pg_read_file', "select pg_read_file('/etc/passwd')"], ['base table', 'select * from admin_login_challenges'], ['sleep', 'select pg_sleep(1)']]) {
			r = await adm.req('/admin/data/query', { method: 'POST', json: { query: q } });
			check(`SQL blocked: ${label}`, r.status === 400, `${r.status} ${r.text.slice(0, 80)}`);
		}
		const [{ n: usersLeft }] = await sql`SELECT count(*)::int AS n FROM users`;
		check('no data was modified by blocked SQL', usersLeft >= 6);
		r = await adm.req('/admin/data/query', { method: 'POST', json: { query: 'select 1' }, origin: 'https://evil.example' });
		check('CSRF: cross-origin SQL POST → 403', r.status === 403);
		const [sa] = await sql`SELECT count(*)::int AS n FROM admin_audit_events WHERE action = 'sql.execute'`;
		check('SQL executions audited (success + denied)', sa.n >= 9);
		const [lit] = await sql`SELECT count(*)::int AS n FROM admin_audit_events WHERE action = 'sql.execute' AND metadata::text LIKE '%passwd%'`;
		check('audit holds a literal-free summary (no raw literals)', lit.n === 0);

		console.log('\nlogs + staff pages + step-up');
		r = await adm.req('/admin/logs');
		check('global logs page renders all sources', r.status === 200 && r.text.includes('Error log') && r.text.includes('Admin audit'));
		r = await adm.req('/admin/logs?source=audit&q=sql.execute');
		check('audit log is browsable', r.status === 200 && r.text.includes('sql.execute'));
		r = await adm.req('/admin/staff');
		check('staff page loads for platform_admin', r.status === 200 && r.text.includes('staff-viewer@co.test'));
		await sql`UPDATE admin_sessions SET mfa_verified_at = now() - interval '10 minutes' WHERE user_id = ${staffAdmin}`;
		r = await adm.req('/admin/staff?/grant', { method: 'POST', form: { email: 'staff-viewer@co.test', role: 'platform_admin', reason: 'e2e grant' } });
		const [g] = await sql`SELECT 1 FROM platform_staff WHERE email = 'staff-viewer@co.test' AND role = 'platform_admin'`;
		check('stale MFA blocks staff changes (step-up required)', r.status === 403 && !g, String(r.status));
		r = await adm.req('/admin/staff');
		check('stale MFA: staff page warns and points to re-verification', r.status === 200 && /MFA check is stale/.test(r.text) && r.text.includes('/admin/reauth'), String(r.status));
		r = await adm.req('/admin/reauth');
		check('reauth page renders', r.status === 200 && /Confirm it/.test(r.text));

		console.log('\nviewer role');
		const v = new Client();
		await v.req('/admin/login', { method: 'POST', form: { email: 'staff-viewer@co.test', password: PW } });
		r = await v.req('/admin/mfa'); const vsecret = /Key: ([A-Z2-7]+)/.exec(r.text)?.[1];
		await v.req('/admin/mfa', { method: 'POST', form: { code: generateSync({ secret: vsecret, strategy: 'totp' }) } });
		check('viewer authenticated', v.jar.has('admin_session'));
		r = await v.req('/admin/accounts'); check('viewer can list accounts', r.status === 200);
		r = await v.req(`/admin/accounts/${A.id}/users`); check('viewer can inspect users (read-only UI)', r.status === 200 && /read-only/.test(r.text));
		r = await v.req('/admin/data/query', { method: 'POST', json: { query: 'select 1' } }); check('viewer cannot run SQL (403)', r.status === 403);
		r = await v.req(`/admin/accounts/${A.id}/users?/manage`, { method: 'POST', form: { userId: adminA, action: 'suspend', reason: 'viewer attempt', confirm: 'admin-a@acme.test' } });
		const [va] = await sql`SELECT is_active FROM users WHERE id = ${adminA}`; check('viewer cannot mutate users (403)', r.status === 403 && va.is_active === true);
		r = await v.req(`/admin/accounts/${A.id}?/update`, { method: 'POST', form: { version: 'x', phone: '1' } }); check('viewer cannot edit account (403)', r.status === 403);
		r = await v.req('/admin/staff'); check('viewer cannot open staff admin (403)', r.status === 403);
		r = await v.req('/api/aws/diagnostic'); check('viewer cannot use infrastructure diagnostics (403)', r.status === 403);
		r = await v.req('/admin/data'); check('viewer can browse data (read)', r.status === 200 && /cannot run SQL/.test(r.text));

		console.log('\nsessions: revocation + logout');
		await sql`UPDATE platform_staff SET is_active = false WHERE user_id = ${staffViewer}`;
		r = await v.req('/admin/accounts'); check('deactivated staff loses access on the very next request', r.status === 303 && r.location.startsWith('/admin/login'));
		await sql`UPDATE admin_sessions SET last_activity_at = now() - interval '25 minutes' WHERE user_id = ${staffAdmin}`;
		r = await adm.req('/admin/accounts'); check('idle session (25 min) expired server-side', r.status === 303);
		// fresh login for the admin (existing MFA): login → challenge → TOTP (wait for next step if same as used)
		const adm2 = new Client();
		await adm2.req('/admin/login', { method: 'POST', form: { email: 'staff-admin@co.test', password: PW, next: '/admin/logs' } });
		r = await adm2.req('/admin/mfa');
		check('second login shows challenge (not enrollment)', /6-digit code/.test(r.text) && !/Key: /.test(r.text));
		r = await adm2.req('/admin/mfa', { method: 'POST', form: { code: generateSync({ secret, strategy: 'totp' }) } });
		check('replayed TOTP (same time step as enrollment) is rejected', r.status === 401);
		r = await adm2.req('/admin/mfa', { method: 'POST', form: { recovery: 'ffffff-ffffff' } });
		check('bad recovery code rejected', r.status === 401);
		const rc = codes0[0];
		r = await adm2.req('/admin/mfa', { method: 'POST', form: { recovery: rc } });
		check('valid recovery code signs in and lands on the admin deep link', r.status === 303 && r.location === '/admin/logs' && adm2.jar.has('admin_session'), `${r.status} ${r.location}`);
		r = await adm2.req('/admin/logs');
		check('recovered session works', r.status === 200);
		const adm4 = new Client();
		await adm4.req('/admin/login', { method: 'POST', form: { email: 'staff-admin@co.test', password: PW } });
		r = await adm4.req('/admin/mfa', { method: 'POST', form: { recovery: rc } });
		check('a recovery code works only once', r.status === 401);
		r = await adm2.req('/admin/logout', { method: 'POST' });
		check('logout revokes the server-side session', r.status === 303 && (await adm2.req('/admin/accounts')).status === 303);
		const [rv] = await sql`SELECT count(*)::int AS n FROM admin_sessions WHERE user_id = ${staffAdmin} AND revoked_reason = 'logout'`;
		check('logout recorded as revocation', rv.n >= 1);
		console.log('\nunauthenticated mutation after logout');
		const adm3 = new Client();
		r = await adm3.req('/admin/accounts'); check('logged-out client has no access', r.status === 303);
	} finally {
		server.kill('SIGTERM');
		await sql.end({ timeout: 2 });
		const a2 = postgres(PG, { max: 1, onnotice: () => {} });
		await a2.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`); await a2.end();
		if (failed) console.log('\n--- server log (tail) ---\n' + serverLog.split('\n').slice(-25).join('\n'));
	}
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
