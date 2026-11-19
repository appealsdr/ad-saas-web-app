import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { sql } from '$lib/server/db';
import { hasDb } from '../setup/db';

const verifySql = readFileSync('db/verify_migrations.sql', 'utf8');
const migrations = readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort();

describe('db/verify_migrations.sql stays in sync with db/migrations', () => {
	it('has checks for every migration file (add checks when you add a migration)', () => {
		for (const f of migrations) {
			const label = `${f.slice(0, 3)} ${f.slice(4, -4)}`;
			expect(verifySql, `no checks for ${f}`).toContain(`('${label.replace(/'/g, "''")}',`);
		}
	});
});

describe.skipIf(!hasDb)('verify_migrations.sql on a fully migrated database', () => {
	it('reports every migration as applied', async () => {
		const insert = verifySql.slice(verifySql.indexOf('INSERT INTO _mig_checks'), verifySql.indexOf(';', verifySql.indexOf('INSERT INTO _mig_checks')) + 1);
		const failing = await sql.begin(async (tx) => {
			await tx.unsafe('CREATE TEMP TABLE _mig_checks (mig text, what text, ok boolean) ON COMMIT DROP');
			await tx.unsafe(insert);
			return tx<{ mig: string; what: string }[]>`SELECT mig, what FROM _mig_checks WHERE NOT ok`;
		});
		expect(failing.map((r) => `${r.mig}: ${r.what}`)).toEqual([]);
	});
});
