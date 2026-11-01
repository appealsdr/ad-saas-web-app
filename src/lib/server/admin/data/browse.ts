/**
 * Table inventory + paginated table browser.
 *
 * Reads ONLY from reviewed `reporting.<view>` projections (never base tables),
 * with column/sort/filter identifiers validated against the view's own column
 * list and all values parameterised. Secret columns are not selected at all —
 * nothing is fetched-then-masked.
 */
import { sql } from '../../db';
import { INVENTORY_BY_NAME, unreviewedEntry, type TableEntry } from './inventory';

export interface InventoryRow {
	name: string;
	view: string | null;
	note: string;
	hidden: string[];
	reviewed: boolean;
	readable: boolean;
	accountScoped: boolean;
	approxRows: number;
}

export async function listInventory(): Promise<InventoryRow[]> {
	const tables = await sql<{ name: string; approx: number }[]>`
		SELECT c.relname AS name, GREATEST(c.reltuples, 0)::bigint::float8 AS approx
		FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
		ORDER BY c.relname
	`;
	return tables.map((t) => {
		const e = INVENTORY_BY_NAME.get(t.name);
		const entry: TableEntry = e ?? unreviewedEntry(t.name);
		return {
			name: t.name,
			view: entry.view,
			note: entry.note,
			hidden: entry.hidden,
			reviewed: !!e,
			readable: !!entry.view,
			accountScoped: !!entry.accountScope,
			approxRows: Math.round(t.approx)
		};
	});
}

export interface ColumnMeta {
	name: string;
	type: string;
	nullable: boolean;
	isPrimaryKey: boolean;
	references: string | null;
	readable: boolean;
}

export async function tableColumns(table: string): Promise<ColumnMeta[]> {
	const cols = await sql<{ name: string; type: string; nullable: boolean }[]>`
		SELECT column_name AS name, data_type AS type, (is_nullable = 'YES') AS nullable
		FROM information_schema.columns
		WHERE table_schema = 'public' AND table_name = ${table}
		ORDER BY ordinal_position
	`;
	if (!cols.length) return []; // unknown table name: never reach the ::regclass lookups
	const view = INVENTORY_BY_NAME.get(table)?.view ?? null;
	const readable = new Set<string>(
		view
			? (
					await sql<{ c: string }[]>`
						SELECT column_name AS c FROM information_schema.columns
						WHERE table_schema = 'reporting' AND table_name = ${view}`
				).map((r) => r.c)
			: []
	);
	const pk = new Set(
		(
			await sql<{ c: string }[]>`
				SELECT a.attname AS c FROM pg_index i
				JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
				WHERE i.indisprimary AND i.indrelid = ${'public.' + table}::regclass`
		).map((r) => r.c)
	);
	const fks = new Map(
		(
			await sql<{ c: string; ref: string }[]>`
				SELECT a.attname AS c, cf.relname || '.' || af.attname AS ref
				FROM pg_constraint k
				JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = k.conkey[1]
				JOIN pg_class cf ON cf.oid = k.confrelid
				JOIN pg_attribute af ON af.attrelid = k.confrelid AND af.attnum = k.confkey[1]
				WHERE k.contype = 'f' AND k.conrelid = ${'public.' + table}::regclass AND array_length(k.conkey, 1) = 1`
		).map((r) => [r.c, r.ref])
	);
	return cols.map((c) => ({
		...c,
		isPrimaryKey: pk.has(c.name),
		references: fks.get(c.name) ?? null,
		readable: readable.has(c.name)
	}));
}

export interface BrowseParams {
	table: string;
	page: number;
	pageSize: number;
	sort?: string | null;
	dir?: 'asc' | 'desc';
	filterColumn?: string | null;
	filterValue?: string | null;
	/** When set, only rows linked to this account (via the documented mapping). */
	accountId?: string | null;
}

export type BrowseResult =
	| { ok: true; columns: string[]; rows: Record<string, unknown>[]; total: number; capped: boolean; scope: string }
	| { ok: false; reason: string };

const COUNT_CAP = 100_000;

export async function browseTable(p: BrowseParams): Promise<BrowseResult> {
	const entry = INVENTORY_BY_NAME.get(p.table);
	if (!entry) return { ok: false, reason: 'Table not reviewed — metadata only.' };
	if (!entry.view) return { ok: false, reason: entry.note };
	if (p.accountId && !entry.accountScope) {
		return { ok: false, reason: 'This table is global/unrelated to an account; browse it from the global data explorer.' };
	}

	const cols = (
		await sql<{ c: string }[]>`
			SELECT column_name AS c FROM information_schema.columns
			WHERE table_schema = 'reporting' AND table_name = ${entry.view}
			ORDER BY ordinal_position`
	).map((r) => r.c);
	if (!cols.length) return { ok: false, reason: 'Projection missing. Apply migration 024.' };

	const sortCol = p.sort && cols.includes(p.sort) ? p.sort : null;
	const filterCol = p.filterColumn && cols.includes(p.filterColumn) ? p.filterColumn : null;
	const filterVal = p.filterValue?.trim() ? `%${p.filterValue.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;

	const view = sql`reporting.${sql(entry.view)}`;
	const scope = p.accountId && entry.accountScope ? entry.accountScope(p.accountId) : sql`true`;
	const filter = filterCol && filterVal ? sql`${sql(filterCol)}::text ILIKE ${filterVal}` : sql`true`;
	const order = sortCol
		? p.dir === 'asc'
			? sql`ORDER BY ${sql(sortCol)} ASC NULLS LAST`
			: sql`ORDER BY ${sql(sortCol)} DESC NULLS LAST`
		: sql``;
	const offset = (p.page - 1) * p.pageSize;

	const rows = await sql<Record<string, unknown>[]>`
		SELECT * FROM ${view} WHERE ${scope} AND ${filter} ${order} LIMIT ${p.pageSize} OFFSET ${offset}
	`;
	const [{ n }] = await sql<{ n: number }[]>`
		SELECT count(*)::int AS n FROM (SELECT 1 FROM ${view} WHERE ${scope} AND ${filter} LIMIT ${COUNT_CAP + 1}) t
	`;
	return {
		ok: true,
		columns: cols,
		rows: rows.map((r) => jsonSafeRow(r)),
		total: Math.min(n, COUNT_CAP),
		capped: n > COUNT_CAP,
		scope: p.accountId ? `Account ${p.accountId}` : 'All customers'
	};
}

/** Make a result row safe to send to the browser without precision loss. */
export function jsonSafeRow(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) out[k] = jsonSafeValue(v);
	return out;
}

export function jsonSafeValue(v: unknown): unknown {
	if (v == null) return null;
	if (typeof v === 'bigint') return v.toString();
	if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
	if (Buffer.isBuffer(v)) return '\\x' + v.toString('hex');
	if (typeof v === 'number' && !Number.isSafeInteger(v) && Number.isInteger(v)) return String(v);
	if (Array.isArray(v)) return v.map(jsonSafeValue);
	if (typeof v === 'object') return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, jsonSafeValue(x)]));
	return v;
}

// ─── Account data explorer (search / filters / logic / export) ─────────────

import { buildFilter, kindOf, type Cond, type Kind } from './filters';

export interface ExplorerColumn { name: string; type: string; kind: Kind }
export interface ExplorerParams {
	table: string;
	accountId: string;
	page: number;
	pageSize: number;
	sort?: string | null;
	dir?: 'asc' | 'desc';
	search?: string | null;
	conds?: Cond[];
	logic?: string;
}
export type ExplorerResult =
	| {
			ok: true; columns: ExplorerColumn[]; rows: Record<string, unknown>[]; total: number; capped: boolean;
			hidden: string[]; relationship: string; filterError: string | null; unused: number[]; incomplete: number; condCount: number;
		}
	| { ok: false; reason: string };

async function viewColumns(view: string): Promise<ExplorerColumn[]> {
	const cols = await sql<{ name: string; type: string }[]>`
		SELECT column_name AS name, data_type AS type FROM information_schema.columns
		WHERE table_schema = 'reporting' AND table_name = ${view} ORDER BY ordinal_position`;
	return cols.map((c) => ({ ...c, kind: kindOf(c.type) }));
}

function scopeAndFilter(p: ExplorerParams, entry: TableEntry, columns: ExplorerColumn[]) {
	const kinds = new Map(columns.map((c) => [c.name, c.kind]));
	const scope = entry.accountScope!(p.accountId);
	const f = buildFilter(p.conds ?? [], p.logic ?? '', kinds);
	const q = p.search?.trim();
	const pat = q ? '%' + q.replace(/[\\%_]/g, (ch) => `\\${ch}`) + '%' : '';
	const search = q
		? sql`(${columns.reduce((acc, c, i) => (i === 0 ? sql`${sql(c.name)}::text ILIKE ${pat}` : sql`${acc} OR ${sql(c.name)}::text ILIKE ${pat}`), sql`false`)})`
		: sql`true`;
	return { scope, f, search };
}

export async function exploreAccountTable(p: ExplorerParams): Promise<ExplorerResult> {
	const entry = INVENTORY_BY_NAME.get(p.table);
	if (!entry?.view || !entry.accountScope) return { ok: false, reason: 'This table is not available for an account.' };
	const columns = await viewColumns(entry.view);
	if (!columns.length) return { ok: false, reason: 'Projection missing. Apply migration 024.' };
	const { scope, f, search } = scopeAndFilter(p, entry, columns);
	const view = sql`reporting.${sql(entry.view)}`;
	const sortCol = p.sort && columns.some((c) => c.name === p.sort) ? p.sort : null;
	const order = sortCol ? (p.dir === 'asc' ? sql`ORDER BY ${sql(sortCol)} ASC NULLS LAST` : sql`ORDER BY ${sql(sortCol)} DESC NULLS LAST`) : sql``;
	const offset = (p.page - 1) * p.pageSize;
	const rows = await sql<Record<string, unknown>[]>`
		SELECT * FROM ${view} WHERE ${scope} AND ${f.where} AND ${search} ${order} LIMIT ${p.pageSize} OFFSET ${offset}`;
	const [{ n }] = await sql<{ n: number }[]>`
		SELECT count(*)::int AS n FROM (SELECT 1 FROM ${view} WHERE ${scope} AND ${f.where} AND ${search} LIMIT ${COUNT_CAP + 1}) t`;
	return {
		ok: true, columns, rows: rows.map((r) => jsonSafeRow(r)), total: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP,
		hidden: entry.hidden, relationship: entry.accountScopeNote ?? '', filterError: f.error, unused: f.unused, incomplete: f.incomplete,
		condCount: (p.conds ?? []).length
	};
}

/** Matching-row count only (powers the live count in the filter dialog). */
export async function countAccountTable(p: ExplorerParams): Promise<{ total: number; capped: boolean; error: string | null }> {
	const entry = INVENTORY_BY_NAME.get(p.table);
	if (!entry?.view || !entry.accountScope) return { total: 0, capped: false, error: 'Unavailable table.' };
	const columns = await viewColumns(entry.view);
	const { scope, f, search } = scopeAndFilter(p, entry, columns);
	if (f.error) return { total: 0, capped: false, error: f.error };
	const view = sql`reporting.${sql(entry.view)}`;
	const [{ n }] = await sql<{ n: number }[]>`
		SELECT count(*)::int AS n FROM (SELECT 1 FROM ${view} WHERE ${scope} AND ${f.where} AND ${search} LIMIT ${COUNT_CAP + 1}) t`;
	return { total: Math.min(n, COUNT_CAP), capped: n > COUNT_CAP, error: null };
}

/** Rows for CSV export — same scope/search/filter/sort, up to `limit`. */
export async function exportAccountRows(p: ExplorerParams, limit = 50_000) {
	const entry = INVENTORY_BY_NAME.get(p.table);
	if (!entry?.view || !entry.accountScope) return null;
	const columns = await viewColumns(entry.view);
	const { scope, f, search } = scopeAndFilter(p, entry, columns);
	if (f.error) return null;
	const view = sql`reporting.${sql(entry.view)}`;
	const sortCol = p.sort && columns.some((c) => c.name === p.sort) ? p.sort : null;
	const order = sortCol ? (p.dir === 'asc' ? sql`ORDER BY ${sql(sortCol)} ASC NULLS LAST` : sql`ORDER BY ${sql(sortCol)} DESC NULLS LAST`) : sql``;
	const rows = await sql<Record<string, unknown>[]>`SELECT * FROM ${view} WHERE ${scope} AND ${f.where} AND ${search} ${order} LIMIT ${limit}`;
	return { columns: columns.map((c) => c.name), rows: rows.map((r) => jsonSafeRow(r)) };
}

/** Row count per account-scoped table (sidebar badges). */
export async function accountTableCounts(accountId: string, names: string[]): Promise<Record<string, number>> {
	const out: Record<string, number> = {};
	await Promise.all(
		names.map(async (name) => {
			const e = INVENTORY_BY_NAME.get(name);
			if (!e?.view || !e.accountScope) return;
			try {
				const [{ n }] = await sql<{ n: number }[]>`
					SELECT count(*)::int AS n FROM (SELECT 1 FROM ${sql`reporting.${sql(e.view)}`} WHERE ${e.accountScope(accountId)} LIMIT 10001) t`;
				out[name] = n;
			} catch {
				out[name] = 0;
			}
		})
	);
	return out;
}
