/**
 * Row filters for the admin data explorer: numbered conditions combined by a
 * logic expression such as `1 AND (2 OR NOT 3)`.
 *
 * Everything user-supplied is validated against the view's own column list and
 * bound as a parameter — never interpolated into SQL.
 */
import { sql } from '../../db';

export type Kind = 'text' | 'int' | 'bool' | 'date';

export interface Cond { col: string; op: string; val: string; val2: string }

export const OPS: Record<Kind, [string, string][]> = {
	text: [['contains', 'contains'], ['eq', 'equals'], ['neq', 'not equal to'], ['ncontains', 'does not contain'], ['starts', 'starts with'], ['ends', 'ends with'], ['empty', 'is empty / NULL'], ['nempty', 'is not empty']],
	int: [['eq', '='], ['neq', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['between', 'between'], ['empty', 'is NULL'], ['nempty', 'is not NULL']],
	bool: [['true', 'is true'], ['false', 'is false'], ['empty', 'is NULL']],
	date: [['on', 'on'], ['before', 'before'], ['after', 'after'], ['between', 'between'], ['lastn', 'in last N days'], ['empty', 'is NULL'], ['nempty', 'is not NULL']]
};
export const NOVAL = ['empty', 'nempty', 'true', 'false'];

export function kindOf(dataType: string): Kind {
	const t = dataType.toLowerCase();
	if (/^(smallint|integer|bigint|numeric|decimal|real|double precision)$/.test(t)) return 'int';
	if (t === 'boolean') return 'bool';
	if (t === 'date' || t.startsWith('timestamp')) return 'date';
	return 'text';
}

type Node = { t: 'c'; n: number } | { t: 'not'; x: Node } | { t: 'and' | 'or'; a: Node; b: Node };

/** Parse a logic expression into an AST. Throws Error with a readable message. */
export function parseLogic(str: string, n: number): { ast: Node; unused: number[] } {
	const toks = str.toUpperCase().match(/\d+|AND|OR|NOT|\(|\)|\S+/g) ?? [];
	let i = 0;
	const used = new Set<number>();
	const peek = () => toks[i];
	const eat = (t: string) => {
		if (toks[i] !== t) throw new Error(i < toks.length ? `Expected ${t} near “${toks[i]}”` : `Expected ${t} at end`);
		i++;
	};
	const factor = (): Node => {
		const t = peek();
		if (t === 'NOT') { i++; return { t: 'not', x: factor() }; }
		if (t === '(') { i++; const e = expr(); eat(')'); return e; }
		if (t && /^\d+$/.test(t)) {
			const k = Number(t);
			if (k < 1 || k > n) throw new Error(`Condition ${k} doesn’t exist`);
			used.add(k); i++;
			return { t: 'c', n: k };
		}
		throw new Error(t ? `Unexpected “${t}”` : 'Expression ends too early');
	};
	const term = (): Node => { let f = factor(); while (peek() === 'AND') { i++; f = { t: 'and', a: f, b: factor() }; } return f; };
	const expr = (): Node => { let f = term(); while (peek() === 'OR') { i++; f = { t: 'or', a: f, b: term() }; } return f; };
	const ast = expr();
	if (i < toks.length) throw new Error(`Unexpected “${toks[i]}”`);
	return { ast, unused: Array.from({ length: n }, (_, k) => k + 1).filter((k) => !used.has(k)) };
}

const like = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** SQL for one condition, or null when it is incomplete/invalid (ignored, like the mockup). */
function condSql(c: Cond, kind: Kind): ReturnType<typeof sql> | null {
	const col = sql(c.col);
	if (c.op === 'empty') return sql`${col} IS NULL`;
	if (c.op === 'nempty') return kind === 'text' ? sql`(${col} IS NOT NULL AND ${col}::text <> '')` : sql`${col} IS NOT NULL`;
	if (kind === 'bool') return c.op === 'true' ? sql`${col} IS TRUE` : c.op === 'false' ? sql`${col} IS FALSE` : null;
	if (kind === 'text') {
		const v = c.val;
		if (v === '') return null;
		switch (c.op) {
			case 'eq': return sql`lower(${col}::text) = lower(${v})`;
			case 'neq': return sql`${col} IS NULL OR lower(${col}::text) <> lower(${v})`;
			case 'contains': return sql`${col}::text ILIKE ${'%' + like(v) + '%'}`;
			case 'ncontains': return sql`${col} IS NULL OR ${col}::text NOT ILIKE ${'%' + like(v) + '%'}`;
			case 'starts': return sql`${col}::text ILIKE ${like(v) + '%'}`;
			case 'ends': return sql`${col}::text ILIKE ${'%' + like(v)}`;
		}
		return null;
	}
	if (kind === 'int') {
		const a = Number(c.val), b = Number(c.val2);
		if (c.val === '' || !Number.isFinite(a)) return null;
		switch (c.op) {
			case 'eq': return sql`${col} = ${a}`;
			case 'neq': return sql`${col} IS NULL OR ${col} <> ${a}`;
			case 'gt': return sql`${col} > ${a}`;
			case 'gte': return sql`${col} >= ${a}`;
			case 'lt': return sql`${col} < ${a}`;
			case 'lte': return sql`${col} <= ${a}`;
			case 'between': return c.val2 === '' || !Number.isFinite(b) ? null : sql`${col} BETWEEN ${Math.min(a, b)} AND ${Math.max(a, b)}`;
		}
		return null;
	}
	// date
	if (c.op === 'lastn') {
		const n = Number(c.val);
		return Number.isFinite(n) && n >= 0 && n <= 36500 ? sql`${col} >= now() - (${n} * interval '1 day')` : null;
	}
	if (!DATE.test(c.val)) return null;
	switch (c.op) {
		case 'on': return sql`${col}::date = ${c.val}::date`;
		case 'before': return sql`${col}::date < ${c.val}::date`;
		case 'after': return sql`${col}::date > ${c.val}::date`;
		case 'between': {
			if (!DATE.test(c.val2)) return null;
			const [lo, hi] = c.val <= c.val2 ? [c.val, c.val2] : [c.val2, c.val];
			return sql`${col}::date BETWEEN ${lo}::date AND ${hi}::date`;
		}
	}
	return null;
}

export interface FilterResult {
	where: ReturnType<typeof sql>;
	error: string | null;
	unused: number[];
	incomplete: number;
}

export function buildFilter(conds: Cond[], logic: string, kinds: Map<string, Kind>): FilterResult {
	const clean = conds.filter((c) => kinds.has(c.col) && (OPS[kinds.get(c.col)!] ?? []).some(([o]) => o === c.op)).slice(0, 12);
	const parts = clean.map((c) => condSql(c, kinds.get(c.col)!));
	const incomplete = parts.filter((p) => p === null).length;
	if (!clean.length) return { where: sql`true`, error: null, unused: [], incomplete: 0 };

	let ast: Node | null = null;
	let unused: number[] = [];
	if (logic.trim()) {
		try { ({ ast, unused } = parseLogic(logic, clean.length)); }
		catch (e) { return { where: sql`true`, error: (e as Error).message, unused: [], incomplete }; }
	}
	const render = (n: Node): ReturnType<typeof sql> => {
		switch (n.t) {
			case 'c': return parts[n.n - 1] ? sql`(${parts[n.n - 1]!})` : sql`true`;
			case 'not': return sql`(NOT ${render(n.x)})`;
			case 'and': return sql`(${render(n.a)} AND ${render(n.b)})`;
			case 'or': return sql`(${render(n.a)} OR ${render(n.b)})`;
		}
	};
	if (ast) return { where: render(ast), error: null, unused, incomplete };
	const live = parts.filter((p): p is NonNullable<typeof p> => p !== null);
	const where = live.reduce((acc, p, i) => (i === 0 ? sql`(${p})` : sql`${acc} AND (${p})`), sql`true`);
	return { where, error: null, unused: [], incomplete };
}

export function parseConds(raw: string | null): Cond[] {
	if (!raw) return [];
	try {
		const arr = JSON.parse(raw);
		if (!Array.isArray(arr)) return [];
		return arr.slice(0, 12).map((c) => ({ col: String(c?.col ?? ''), op: String(c?.op ?? ''), val: String(c?.val ?? '').slice(0, 300), val2: String(c?.val2 ?? '').slice(0, 300) }));
	} catch {
		return [];
	}
}
