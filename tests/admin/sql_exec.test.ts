import { describe, it, expect } from 'vitest';
import { validateSql } from '../../src/lib/server/admin/data/sql_exec';

describe('admin SQL console validation', () => {
	it('accepts well-formed statements', () => {
		expect(validateSql('update', 'stores', "UPDATE stores SET name = 'a;b -- x' WHERE id = '1';")).toContain('UPDATE stores');
		expect(validateSql('delete', 'stores', "DELETE FROM public.stores WHERE id = '1'")).toBeTruthy();
		expect(validateSql('insert', 'stores', "INSERT INTO stores (name) VALUES ('x')")).toBeTruthy();
	});
	it('rejects unsafe statements', () => {
		const bad: [any, string, string][] = [
			['update', 'stores', 'UPDATE stores SET name = 1'],
			['delete', 'stores', 'DELETE FROM stores'],
			['update', 'stores', "UPDATE stores SET name='a' WHERE id='1'; DROP TABLE stores"],
			['update', 'stores', "UPDATE stores SET name='a' WHERE 1=1 -- x"],
			['delete', 'stores', 'DELETE FROM users WHERE id=1'],
			['delete', 'stores', 'DELETE FROM stores WHERE id IN (SELECT id FROM sessions)'],
			['update', 'stores', "UPDATE stores SET name='a' WHERE id=1 RETURNING *"],
			['update', 'sessions', 'UPDATE sessions SET x=1 WHERE 1=1'],
			['delete', 'stores', 'UPDATE stores SET a=1 WHERE 1=1']
		];
		for (const [op, t, s] of bad) expect(() => validateSql(op, t, s), s).toThrow();
	});
});
