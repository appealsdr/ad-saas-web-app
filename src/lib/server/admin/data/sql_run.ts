/**
 * Execute a validated read-only query as the SQL reader role.
 *
 * Limits (defaults; see constants): 5 s statement timeout, 1 s lock timeout,
 * 500 displayed rows (hard max 1000), 2 MB response, ONE active query per
 * administrator across replicas (admin_sql_active). Rows are pulled through a
 * cursor and the fetch STOPS at the bounds — nothing unbounded is buffered.
 * The transaction is always rolled back and the connection released.
 */
import { sql } from '../../db';
import { redactString } from '../redact';
import { getVerifiedReader, ReaderUnavailableError } from './reader_db';
import { jsonSafeRow } from './browse';
import { SqlValidationError, validateReadOnlySql } from './sql_validate';

export const STATEMENT_TIMEOUT_MS = 5_000;
export const LOCK_TIMEOUT_MS = 1_000;
export const DEFAULT_ROWS = 500;
export const MAX_ROWS = 1_000;
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const LOCK_TTL_SECONDS = 20;

export interface SqlColumn {
	name: string;
	type: string;
}

export interface SqlRunResult {
	columns: SqlColumn[];
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
	truncatedBy: 'rows' | 'bytes' | null;
	elapsedMs: number;
	scope: 'All customers';
}

export class SqlBusyError extends Error {}
export class SqlExecutionError extends Error {
	constructor(
		message: string,
		readonly code?: string
	) {
		super(message);
	}
}

const OID_TYPES: Record<number, string> = {
	16: 'boolean', 17: 'bytea', 20: 'bigint', 21: 'smallint', 23: 'integer', 25: 'text', 114: 'json',
	700: 'real', 701: 'double', 1042: 'char', 1043: 'varchar', 1082: 'date', 1114: 'timestamp',
	1184: 'timestamptz', 1186: 'interval', 1700: 'numeric', 2950: 'uuid', 3802: 'jsonb', 869: 'inet',
	1009: 'text[]', 1007: 'integer[]', 1015: 'varchar[]', 2951: 'uuid[]'
};

async function acquire(userId: string): Promise<void> {
	const rows = await sql`
		INSERT INTO admin_sql_active AS a (user_id, expires_at)
		VALUES (${userId}, now() + (${LOCK_TTL_SECONDS} * interval '1 second'))
		ON CONFLICT (user_id) DO UPDATE SET started_at = now(), expires_at = EXCLUDED.expires_at
			WHERE a.expires_at < now()
		RETURNING user_id
	`;
	if (!rows.length) throw new SqlBusyError('A query is already running for your account. Wait for it to finish.');
}

async function release(userId: string): Promise<void> {
	await sql`DELETE FROM admin_sql_active WHERE user_id = ${userId}`.catch(() => {});
}

export async function runReadOnlySql(opts: {
	userId: string;
	query: string;
	maxRows?: number;
	signal?: AbortSignal;
}): Promise<SqlRunResult & { validatedQuery: string; tables: string[] }> {
	const validated = validateReadOnlySql(opts.query); // throws SqlValidationError
	const maxRows = Math.min(Math.max(opts.maxRows ?? DEFAULT_ROWS, 1), MAX_ROWS);
	const reader = await getVerifiedReader(); // throws ReaderUnavailableError (never falls back)

	await acquire(opts.userId);
	const started = performance.now();
	try {
		const rows: Record<string, unknown>[] = [];
		let columns: SqlColumn[] = [];
		let truncatedBy: 'rows' | 'bytes' | null = null;
		let bytes = 0;

		const ROLLBACK = Symbol('rollback');
		try {
			await reader.begin('read only', async (tx) => {
				await tx.unsafe(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
				await tx.unsafe(`SET LOCAL lock_timeout = ${LOCK_TIMEOUT_MS}`);
				await tx.unsafe(`SET LOCAL idle_in_transaction_session_timeout = 10000`);
				await tx.unsafe(`SET LOCAL search_path = reporting`);

				const q = tx.unsafe(validated.query);
				const onAbort = () => void q.cancel();
				opts.signal?.addEventListener('abort', onAbort, { once: true });
				try {
					const described = await tx.unsafe(validated.query).describe();
					columns = (described.columns ?? []).map((c: { name: string; type: number }) => ({
						name: c.name,
						type: OID_TYPES[c.type] ?? `oid:${c.type}`
					}));
					await q.cursor(100, (batch: Record<string, unknown>[]) => {
						for (const raw of batch) {
							if (rows.length >= maxRows) {
								truncatedBy = 'rows';
								return reader.CLOSE;
							}
							const row = jsonSafeRow(raw);
							bytes += JSON.stringify(row).length;
							if (bytes > MAX_RESPONSE_BYTES) {
								truncatedBy = 'bytes';
								return reader.CLOSE;
							}
							rows.push(row);
						}
					});
				} finally {
					opts.signal?.removeEventListener('abort', onAbort);
				}
				throw ROLLBACK; // never commit anything from the reader
			});
		} catch (e) {
			if (e !== ROLLBACK) throw e;
		}

		return {
			columns,
			rows,
			rowCount: rows.length,
			truncated: truncatedBy !== null,
			truncatedBy,
			elapsedMs: Math.round(performance.now() - started),
			scope: 'All customers',
			validatedQuery: validated.query,
			tables: validated.tables
		};
	} catch (e) {
		throw mapError(e);
	} finally {
		await release(opts.userId);
	}
}

function mapError(e: unknown): Error {
	if (e instanceof SqlValidationError || e instanceof ReaderUnavailableError || e instanceof SqlBusyError) return e;
	const err = e as { code?: string; message?: string; severity?: string };
	if (err?.code === '57014') return new SqlExecutionError(`Query cancelled: exceeded ${STATEMENT_TIMEOUT_MS / 1000}s timeout or was cancelled.`, err.code);
	if (err?.code === '55P03') return new SqlExecutionError('Query could not acquire a lock in time.', err.code);
	if (err?.code === '42501') return new SqlExecutionError('Permission denied for that object.', err.code);
	if (typeof err?.code === 'string' && /^(42|22|21|23|0A)/.test(err.code)) {
		// Syntax / type / data errors from Postgres are safe and useful to show (redacted, bounded).
		return new SqlExecutionError(redactString(String(err.message ?? 'Query failed')).slice(0, 400), err.code);
	}
	return new SqlExecutionError('Query failed.', err?.code);
}
