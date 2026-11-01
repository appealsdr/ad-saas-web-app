import { describe, expect, it } from 'vitest';
import { kindOf, parseConds, parseLogic } from '../../src/lib/server/admin/data/filters';

describe('data explorer filters', () => {
	it('maps postgres types to filter kinds', () => {
		expect(kindOf('integer')).toBe('int');
		expect(kindOf('numeric')).toBe('int');
		expect(kindOf('boolean')).toBe('bool');
		expect(kindOf('timestamp with time zone')).toBe('date');
		expect(kindOf('date')).toBe('date');
		expect(kindOf('uuid')).toBe('text');
		expect(kindOf('text')).toBe('text');
	});

	it('parses logic with precedence AND > OR and parentheses', () => {
		const a = parseLogic('1 OR 2 AND 3', 3).ast;
		expect(a).toMatchObject({ t: 'or', a: { t: 'c', n: 1 }, b: { t: 'and' } });
		const b = parseLogic('(1 OR 2) AND NOT 3', 3);
		expect(b.ast).toMatchObject({ t: 'and', a: { t: 'or' }, b: { t: 'not', x: { t: 'c', n: 3 } } });
		expect(b.unused).toEqual([]);
	});

	it('reports unused conditions and bad expressions', () => {
		expect(parseLogic('1 and 3', 3).unused).toEqual([2]);
		expect(() => parseLogic('1 AND 4', 3)).toThrow(/doesn’t exist/);
		expect(() => parseLogic('1 AND', 2)).toThrow();
		expect(() => parseLogic('(1 OR 2', 2)).toThrow();
		expect(() => parseLogic('1 2', 2)).toThrow();
		expect(() => parseLogic("1; DROP TABLE users", 1)).toThrow();
	});

	it('parses and bounds the conditions payload', () => {
		expect(parseConds(null)).toEqual([]);
		expect(parseConds('not json')).toEqual([]);
		expect(parseConds('{"a":1}')).toEqual([]);
		const many = JSON.stringify(Array.from({ length: 30 }, () => ({ col: 'a', op: 'eq', val: 'x'.repeat(500) })));
		const out = parseConds(many);
		expect(out).toHaveLength(12);
		expect(out[0].val).toHaveLength(300);
	});
});
