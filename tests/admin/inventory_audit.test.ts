import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sql } from '$lib/server/db';
import { hasDb } from '../setup/db';
import { INVENTORY, INVENTORY_BY_NAME, REPORTING_VIEWS } from '$lib/server/admin/data/inventory';
import { listInventory, tableColumns, browseTable } from '$lib/server/admin/data/browse';

const d = describe.skipIf(!hasDb);

d('table inventory', () => {
	it('every application table has a reviewed projection or an explicit restriction', async () => {
		const tables = (await sql<{ t: string }[]>`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`).map((r) => r.t).sort();
		const missing = tables.filter((t) => !INVENTORY_BY_NAME.has(t));
		expect(missing, `tables missing from inventory.ts: ${missing.join(', ')}`).toEqual([]);
		const stale = INVENTORY.map((e) => e.name).filter((n) => !tables.includes(n));
		expect(stale, `inventory entries without a table: ${stale.join(', ')}`).toEqual([]);
		for (const e of INVENTORY) expect(e.view !== null || e.note.length > 0).toBe(true);
	});
	it('reporting schema contains exactly the inventoried views', async () => {
		const views = (await sql<{ v: string }[]>`SELECT table_name AS v FROM information_schema.views WHERE table_schema = 'reporting'`).map((r) => r.v).sort();
		expect(views).toEqual([...REPORTING_VIEWS].sort());
	});
	it('hidden columns are exactly the columns NOT projected (inventory cannot drift from the views)', async () => {
		for (const e of INVENTORY.filter((x) => x.view)) {
			const base = (await sql<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema='public' AND table_name=${e.name}`).map((r) => r.c);
			const view = (await sql<{ c: string }[]>`SELECT column_name AS c FROM information_schema.columns WHERE table_schema='reporting' AND table_name=${e.view!}`).map((r) => r.c);
			const notProjected = base.filter((c) => !view.includes(c)).sort();
			expect([...e.hidden].sort(), `${e.name}`).toEqual(notProjected);
		}
	});
	it('metadata-only tables expose no data', async () => {
		for (const e of INVENTORY.filter((x) => !x.view)) {
			const r = await browseTable({ table: e.name, page: 1, pageSize: 10 });
			expect(r.ok, e.name).toBe(false);
			expect((await tableColumns(e.name)).every((c) => !c.readable)).toBe(true);
		}
	});
	it('a newly created, unreviewed table appears as metadata-only and is unreadable', async () => {
		await sql`CREATE TABLE IF NOT EXISTS zz_new_unreviewed (id int, secret_note text)`;
		try {
			const inv = await listInventory();
			const row = inv.find((t) => t.name === 'zz_new_unreviewed')!;
			expect(row).toMatchObject({ reviewed: false, readable: false, view: null });
			const r = await browseTable({ table: 'zz_new_unreviewed', page: 1, pageSize: 10 });
			expect(r.ok).toBe(false);
		} finally { await sql`DROP TABLE zz_new_unreviewed`; }
	});
	it('unknown tables and identifier injection are refused by allowlists', async () => {
		expect((await browseTable({ table: 'users; drop table users', page: 1, pageSize: 5 })).ok).toBe(false);
		expect((await browseTable({ table: 'pg_authid', page: 1, pageSize: 5 })).ok).toBe(false);
		await sql`SELECT 1`;
		const r = await browseTable({ table: 'users', page: 1, pageSize: 5, sort: 'id; drop table users', filterColumn: 'email" or 1=1 --', filterValue: "x' or '1'='1" });
		expect(r.ok).toBe(true); // bad identifiers are ignored, never interpolated
		if (r.ok) expect(r.columns).not.toContain('password_hash');
		expect((await tableColumns('no_such_table"; --')).length).toBe(0);
	});
	it('browse results never contain secret columns', async () => {
		for (const e of INVENTORY.filter((x) => x.view)) {
			const r = await browseTable({ table: e.name, page: 1, pageSize: 5 });
			expect(r.ok).toBe(true);
			if (r.ok) for (const h of e.hidden) expect(r.columns, `${e.name}.${h}`).not.toContain(h);
		}
	});
});

d('audit trail is append-only and survives deletion of referenced rows', () => {
	it('UPDATE / DELETE / TRUNCATE are rejected', async () => {
		const [e] = await sql<{ id: string }[]>`INSERT INTO admin_audit_events (actor_ref, action, outcome) VALUES ('t', 'test.immutable', 'success') RETURNING id`;
		await expect(sql`UPDATE admin_audit_events SET action = 'x' WHERE id = ${e.id}`).rejects.toThrow(/append-only/);
		await expect(sql`DELETE FROM admin_audit_events WHERE id = ${e.id}`).rejects.toThrow(/append-only/);
		await expect(sql`TRUNCATE admin_audit_events`).rejects.toThrow(/append-only/);
	});
	it('events persist after the actor user and target account are removed (no FKs)', async () => {
		const [a] = await sql<{ id: string }[]>`INSERT INTO accounts (name) VALUES ('to-delete') RETURNING id`;
		const [u] = await sql<{ id: string }[]>`INSERT INTO users (email) VALUES ('gone@example.test') RETURNING id`;
		await sql`INSERT INTO admin_audit_events (actor_user_id, actor_ref, action, target_account_id, outcome) VALUES (${u.id}, 'gone@example.test', 'test.survive', ${a.id}, 'success')`;
		await sql`DELETE FROM users WHERE id = ${u.id}`;
		await sql`DELETE FROM accounts WHERE id = ${a.id}`;
		const [row] = await sql<{ actor_ref: string }[]>`SELECT actor_ref FROM admin_audit_events WHERE action = 'test.survive'`;
		expect(row.actor_ref).toBe('gone@example.test');
	});
	it('rejects invalid outcomes and redacts metadata at write time', async () => {
		await expect(sql`INSERT INTO admin_audit_events (actor_ref, action, outcome) VALUES ('t', 'x', 'maybe')`).rejects.toThrow();
		const { recordAudit } = await import('$lib/server/admin/audit');
		const id = await recordAudit({ actor: { userId: null, ref: 't' }, action: 'test.redact', outcome: 'success', metadata: { password: 'p', nested: { token: 't' }, note: 'Bearer abcdefghijklmnop' } });
		const [row] = await sql<{ metadata: unknown }[]>`SELECT metadata FROM admin_audit_events WHERE id = ${id}`;
		expect(JSON.stringify(row.metadata)).not.toMatch(/abcdefghijklmnop|"p"|"t"/);
	});
});

describe('migrations', () => {
	it('are numbered contiguously and the new ones are additive (no destructive statements)', () => {
		const dir = join(__dirname, '..', '..', 'db', 'migrations');
		const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
		files.forEach((f, i) => expect(Number(f.slice(0, 3)), f).toBe(i + 1));
		for (const f of files.filter((f) => /^02[34]_/.test(f))) {
			const sqlText = readFileSync(join(dir, f), 'utf8').replace(/--.*$/gm, '');
			expect(sqlText, f).not.toMatch(/\bDROP\s+(TABLE|COLUMN|SCHEMA)\b|^\s*TRUNCATE\b|\bDELETE\s+FROM\b/im);
		}
	});
	it.skipIf(!hasDb)('re-applying 023 and 025 is idempotent (the 024 view is superseded by 025)', async () => {
		const dir = join(__dirname, '..', '..', 'db', 'migrations');
		for (const f of ['023_platform_admin.sql', '025_account_subscriptions.sql']) await sql.unsafe(readFileSync(join(dir, f), 'utf8'));
	});
});

describe('no raw HTML rendering of stored content', () => {
	it('admin Svelte files avoid {@html} except the MFA QR code (server-generated SVG)', () => {
		const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
		const root = join(__dirname, '..', '..', 'src');
		const files = [...walk(join(root, 'routes', 'admin')), ...walk(join(root, 'lib', 'components', 'admin'))].filter((f) => f.endsWith('.svelte'));
		expect(files.length).toBeGreaterThan(10);
		for (const f of files) {
			const src = readFileSync(f, 'utf8');
			if (src.includes('{@html')) expect(f.endsWith(join('mfa', '+page.svelte')), f).toBe(true);
		}
	});
});
