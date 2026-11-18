/**
 * Admin SQL console (AD-1947): run a single INSERT / UPDATE / DELETE against one reviewed account table.
 *
 * Safeguards (defence in depth — the real gates are the `data.write` permission, fresh MFA and the audit trail):
 *   - exactly ONE statement; the verb must match the chosen operation and target the chosen table only
 *   - UPDATE / DELETE must have a WHERE clause; RETURNING, comments, dollar-quotes and ';' are rejected
 *   - only tables in WRITABLE_TABLES; security/auth/audit tables are never writable
 *   - other tables and system catalogs/functions may not be referenced
 *   - every run is first PREVIEWED inside a transaction that is rolled back; the commit re-runs it and aborts
 *     unless the affected-row count equals the previewed count
 *   - 5s statement timeout, and at most MAX_ROWS rows may be affected
 *   - the full statement text is written to the audit log
 */
import { sql } from '../../db';
import { INVENTORY } from './inventory';
import { recordAudit, type AuditActor } from '../audit';
import { ActionError, requireReason } from '../actions';
import { logError, describeError } from '../../error_log';

export type SqlOp = 'insert' | 'update' | 'delete';
export const MAX_ROWS = 1000;
export const WRITABLE_TABLES = [
	'accounts', 'users', 'account_contacts', 'stores', 'store_documents', 'case_documents',
	'service_contracts', 'service_contract_line_items'
] as const;

const SYSTEM = ['pg_', 'information_schema', 'set_config', 'dblink', 'lo_import', 'lo_export', 'copy', 'reporting', 'current_setting', 'returning'];

/** Statement with string literals and quoted identifiers blanked out, for structural checks. */
function skeleton(stmt: string): string {
	let out = '';
	let i = 0;
	while (i < stmt.length) {
		const c = stmt[i];
		if (c === "'" || c === '"') {
			let j = i + 1;
			for (; j < stmt.length; j++) {
				if (stmt[j] === c) { if (stmt[j + 1] === c) { j++; continue; } break; }
			}
			if (j >= stmt.length) throw new ActionError('Unterminated quote in SQL.', 422);
			out += c === '"' ? stmt.slice(i, j + 1) : "''"; // keep quoted identifiers, blank literals
			i = j + 1;
		} else { out += c; i++; }
	}
	return out;
}

export function validateSql(op: SqlOp, table: string, raw: string): string {
	if (!(WRITABLE_TABLES as readonly string[]).includes(table)) throw new ActionError(`Table “${table}” cannot be modified from the console.`, 403);
	const stmt = raw.trim().replace(/;\s*$/, '').trim();
	if (!stmt) throw new ActionError('Enter an SQL statement.', 422);
	if (stmt.length > 5000) throw new ActionError('Statement is too long (5000 characters max).', 422);
	const sk = skeleton(stmt);
	if (/;|--|\/\*|\$/.test(sk)) throw new ActionError('Only a single statement is allowed (no “;”, comments or dollar-quoting).', 422);
	const t = `(?:public\\.)?"?${table}"?`;
	const head = { insert: new RegExp(`^insert\\s+into\\s+${t}(?=[\\s(])`, 'i'), update: new RegExp(`^update\\s+${t}\\s`, 'i'), delete: new RegExp(`^delete\\s+from\\s+${t}(?=\\s|$)`, 'i') }[op];
	if (!head.test(sk)) throw new ActionError(`Statement must start with ${op === 'insert' ? `INSERT INTO ${table}` : op === 'update' ? `UPDATE ${table} SET` : `DELETE FROM ${table}`}.`, 422);
	if (op !== 'insert' && !/\bwhere\b/i.test(sk)) throw new ActionError(`${op.toUpperCase()} requires a WHERE clause.`, 422);
	const lower = sk.toLowerCase();
	for (const w of SYSTEM) if (new RegExp(`\\b${w}`, 'i').test(lower)) throw new ActionError(`“${w}” is not allowed in console statements.`, 422);
	const others = INVENTORY.map((e) => e.name).filter((n) => n !== table && !(WRITABLE_TABLES as readonly string[]).includes(n));
	for (const n of others) if (new RegExp(`\\b${n}\\b`, 'i').test(lower)) throw new ActionError(`Table “${n}” may not be referenced.`, 403);
	return stmt;
}

class Rollback extends Error {}

async function runInTx(stmt: string, commit: boolean, expected: number | null, audit?: Parameters<typeof recordAudit>[0]): Promise<number> {
	let count = 0;
	try {
		await sql.begin(async (tx) => {
			await tx.unsafe(`SET LOCAL statement_timeout = '5s'`);
			const res = await tx.unsafe(stmt);
			count = res.count ?? 0;
			if (count > MAX_ROWS) throw new ActionError(`Statement would affect ${count} rows (max ${MAX_ROWS}). Nothing was changed.`, 422);
			if (!commit) throw new Rollback();
			if (expected !== null && count !== expected) throw new ActionError(`Row count changed since preview (${expected} → ${count}). Nothing was changed; preview again.`, 409);
			if (audit) await recordAudit({ ...audit, metadata: { ...(audit.metadata ?? {}), rows: count } }, tx);
		});
	} catch (e) {
		if (e instanceof Rollback) return count;
		if (e instanceof ActionError) throw e;
		const d = describeError(e);
		await logError({ source: 'admin.sql_console', operation: commit ? 'execute' : 'preview', errorMessage: d.errorMessage, stack: d.stack });
		throw new ActionError(`SQL error: ${d.errorMessage}`.slice(0, 400), 422);
	}
	return count;
}

/** Dry run: executes inside a transaction that is always rolled back. Returns the affected row count. */
export async function previewSql(op: SqlOp, table: string, raw: string): Promise<{ stmt: string; rows: number }> {
	const stmt = validateSql(op, table, raw);
	return { stmt, rows: await runInTx(stmt, false, null) };
}

export async function executeSql(
	ctx: { actor: AuditActor; ip?: string | null }, accountId: string | null, op: SqlOp, table: string, raw: string, expectedRows: number, reason: string
): Promise<string> {
	const why = requireReason(reason);
	const stmt = validateSql(op, table, raw);
	const rows = await runInTx(stmt, true, expectedRows, {
		actor: ctx.actor, action: 'data.sql_execute', targetType: table, targetAccountId: accountId ?? undefined,
		outcome: 'success', reason: why, ip: ctx.ip, metadata: { op, table, sql: stmt }
	});
	return `${op.toUpperCase()} on ${table} committed: ${rows} row(s) affected.`;
}
