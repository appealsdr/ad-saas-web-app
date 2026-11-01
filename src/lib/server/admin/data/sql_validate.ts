/**
 * Defence-in-depth validation for the inline SQL editor.
 *
 * THE SECURITY BOUNDARY IS THE DATABASE: the reader role has SELECT only on
 * the reporting views and the query runs in a READ ONLY transaction. This
 * validator is the second layer. It uses a real SQL parser (pgsql-ast-parser,
 * which fails closed on any syntax it does not understand) and then walks the
 * AST with an allowlist approach:
 *
 *   - exactly one statement; SELECT / UNION / VALUES / WITH ... SELECT only
 *   - no writable CTEs, no WITH RECURSIVE, no locking clauses
 *   - every relation must be a reporting view (unqualified names resolve via
 *     the reader role's search_path = reporting) or a CTE defined in the query
 *   - CTE names may not start with `pg_` (they could otherwise shadow/forge
 *     catalog names in an out-of-scope position)
 *   - schema-qualified references other than `reporting.` are rejected
 *   - only an allowlist of side-effect-free functions may be called
 *   - no casts to reg* / oid types
 */
import { astVisitor, parse, type Statement } from 'pgsql-ast-parser';
import { REPORTING_VIEWS } from './inventory';

export class SqlValidationError extends Error {}

export const MAX_QUERY_CHARS = 20_000;

export const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
	// aggregates
	'count', 'sum', 'avg', 'min', 'max', 'bool_and', 'bool_or', 'every', 'string_agg', 'array_agg',
	'json_agg', 'jsonb_agg', 'json_object_agg', 'jsonb_object_agg', 'stddev', 'variance',
	// conditional / generic
	'coalesce', 'nullif', 'greatest', 'least',
	// text
	'lower', 'upper', 'length', 'char_length', 'character_length', 'substr', 'substring', 'trim', 'ltrim',
	'rtrim', 'btrim', 'replace', 'concat', 'concat_ws', 'left', 'right', 'split_part', 'position', 'strpos',
	'starts_with', 'initcap', 'reverse', 'regexp_replace', 'format', 'to_char',
	// math
	'abs', 'ceil', 'ceiling', 'floor', 'round', 'trunc', 'mod', 'power', 'sqrt', 'sign',
	// dates
	'now', 'current_date', 'current_timestamp', 'date_trunc', 'date_part', 'extract', 'age', 'to_date',
	'to_timestamp', 'make_interval', 'timezone',
	// json / arrays
	'jsonb_typeof', 'json_typeof', 'jsonb_array_length', 'json_array_length', 'jsonb_extract_path',
	'jsonb_extract_path_text', 'jsonb_build_object', 'json_build_object', 'jsonb_build_array',
	'json_build_array', 'to_jsonb', 'to_json', 'jsonb_pretty', 'jsonb_object_keys', 'array_length',
	'cardinality', 'array_to_string', 'string_to_array', 'unnest', 'jsonb_array_elements',
	'jsonb_array_elements_text', 'jsonb_each', 'jsonb_each_text', 'generate_series',
	// window
	'row_number', 'rank', 'dense_rank', 'percent_rank', 'ntile', 'lag', 'lead', 'first_value', 'last_value',
	'nth_value'
]);

interface Found {
	tables: Array<{ schema?: string; name: string }>;
	functions: Array<{ schema?: string; name: string }>;
	casts: string[];
	badCte: boolean;
	ctes: Set<string>;
}

function walkStatement(root: Statement): Found {
	const found: Found = { tables: [], functions: [], casts: [], badCte: false, ctes: new Set() };

	const checkBody = (st: Statement): void => {
		switch (st.type) {
			case 'select':
			case 'union':
			case 'union all':
			case 'values':
				return;
			case 'with':
				// handled by the visitor below
				return;
			default:
				throw new SqlValidationError(`Only read-only SELECT queries are allowed (found ${st.type}).`);
		}
	};

	const v = astVisitor((map) => ({
		with: (st) => {
			for (const b of st.bind) {
				found.ctes.add(b.alias.name.toLowerCase());
				checkBody(b.statement as Statement);
			}
			checkBody(st.in as Statement);
			map.super().with(st);
		},
		withRecursive: () => {
			throw new SqlValidationError('WITH RECURSIVE is not allowed.');
		},
		selection: (st) => {
			if ((st as { for?: unknown }).for) throw new SqlValidationError('Locking clauses (FOR UPDATE/SHARE) are not allowed.');
			map.super().selection(st);
		},
		tableRef: (t) => {
			found.tables.push({ schema: t.schema, name: t.name });
			map.super().tableRef(t);
		},
		call: (c) => {
			found.functions.push({ schema: c.function.schema, name: c.function.name });
			map.super().call(c);
		},
		fromCall: (c) => {
			found.functions.push({ schema: c.function.schema, name: c.function.name });
			map.super().fromCall(c);
		},
		cast: (c) => {
			const t = c.to as { name?: string };
			if (t?.name) found.casts.push(t.name.toLowerCase());
			map.super().cast(c);
		}
	}));
	v.statement(root);
	return found;
}

export interface ValidatedQuery {
	query: string;
	tables: string[];
}

export function validateReadOnlySql(input: string): ValidatedQuery {
	const query = input.trim().replace(/;+\s*$/, '');
	if (!query) throw new SqlValidationError('Enter a query to run.');
	if (query.length > MAX_QUERY_CHARS) throw new SqlValidationError(`Query is too long (max ${MAX_QUERY_CHARS} characters).`);
	if (query.includes('\u0000')) throw new SqlValidationError('Invalid characters in query.');

	let statements: Statement[];
	try {
		statements = parse(query);
	} catch (e) {
		const msg = e instanceof Error ? e.message.split('\n')[0] : 'unparseable';
		throw new SqlValidationError(`Could not parse as a supported read-only SELECT: ${msg}`);
	}
	if (statements.length !== 1) throw new SqlValidationError('Exactly one statement is allowed.');
	const stmt = statements[0];
	if (!['select', 'union', 'union all', 'values', 'with'].includes(stmt.type)) {
		throw new SqlValidationError(`Only SELECT queries are allowed (found ${stmt.type}).`);
	}

	const found = walkStatement(stmt);

	for (const cte of found.ctes) {
		if (cte.startsWith('pg_') || cte === 'information_schema') {
			throw new SqlValidationError(`CTE name "${cte}" is reserved.`);
		}
	}
	const tables: string[] = [];
	for (const t of found.tables) {
		const name = t.name.toLowerCase();
		const schema = t.schema?.toLowerCase();
		if (schema) {
			if (schema !== 'reporting') throw new SqlValidationError(`Schema "${t.schema}" is not accessible. Use the reporting views (e.g. reporting.users).`);
			if (!REPORTING_VIEWS.has(name)) throw new SqlValidationError(`"${t.name}" is not an available view.`);
			tables.push(name);
			continue;
		}
		if (found.ctes.has(name)) continue;
		if (!REPORTING_VIEWS.has(name)) throw new SqlValidationError(`"${t.name}" is not an available view. Use the table list on the left.`);
		tables.push(name);
	}
	for (const f of found.functions) {
		if (f.schema) throw new SqlValidationError(`Schema-qualified function "${f.schema}.${f.name}" is not allowed.`);
		if (!ALLOWED_FUNCTIONS.has(f.name.toLowerCase())) throw new SqlValidationError(`Function "${f.name}" is not allowed.`);
	}
	for (const c of found.casts) {
		if (c.startsWith('reg') || c === 'oid' || c === 'xid' || c === 'cid') throw new SqlValidationError(`Cast to ${c} is not allowed.`);
	}
	return { query, tables: [...new Set(tables)] };
}

/** Stable fingerprint input + a literal-free summary for the audit log. */
export function summariseQuery(query: string): string {
	return query
		.replace(/'(?:[^']|'')*'/g, "'?'")
		.replace(/\b\d+(?:\.\d+)?\b/g, '?')
		.replace(/\s+/g, ' ')
		.trim()
		.slice(0, 500);
}
