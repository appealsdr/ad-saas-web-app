/**
 * POST /admin/data/query — run ONE read-only SQL statement as the reader role.
 * Auth: platform_admin (`data.query`). Origin-checked in hooks (JSON fetch).
 */
import { json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import type { RequestHandler } from './$types';
import { auditActor, clientIp, requireStaff } from '$lib/server/admin/guard';
import { recordAudit } from '$lib/server/admin/audit';
import { SqlBusyError, SqlExecutionError, runReadOnlySql } from '$lib/server/admin/data/sql_run';
import { SqlValidationError, summariseQuery } from '$lib/server/admin/data/sql_validate';
import { ReaderUnavailableError } from '$lib/server/admin/data/reader_db';

export const POST: RequestHandler = async (event) => {
	const staff = requireStaff(event, 'data.query');
	let body: { query?: unknown; maxRows?: unknown };
	try {
		body = await event.request.json();
	} catch {
		return json({ message: 'Invalid JSON body.' }, { status: 400 });
	}
	const query = typeof body.query === 'string' ? body.query : '';
	const maxRows = typeof body.maxRows === 'number' ? body.maxRows : undefined;

	const fingerprint = createHash('sha256').update(summariseQuery(query)).digest('hex').slice(0, 16);
	const base = {
		actor: auditActor(staff),
		action: 'sql.execute',
		targetType: 'sql',
		ip: clientIp(event)
	} as const;
	const meta = { fingerprint, summary: summariseQuery(query) };

	try {
		const r = await runReadOnlySql({ userId: staff.userId, query, maxRows, signal: event.request.signal });
		// Failure to audit an executed query is surfaced (no silent un-audited SQL).
		await recordAudit({ ...base, outcome: 'success', metadata: { ...meta, durationMs: r.elapsedMs, rowCount: r.rowCount, truncated: r.truncated, tables: r.tables } });
		const { validatedQuery: _v, tables: _t, ...result } = r;
		return json(result);
	} catch (e) {
		const outcome = e instanceof SqlValidationError ? 'denied' : 'failure';
		await recordAudit({ ...base, outcome, metadata: { ...meta, error: e instanceof Error ? e.message.slice(0, 200) : 'error' } }, undefined, { bestEffort: true });
		if (e instanceof SqlValidationError) return json({ message: e.message }, { status: 400 });
		if (e instanceof SqlBusyError) return json({ message: e.message }, { status: 429 });
		if (e instanceof ReaderUnavailableError) return json({ message: e.message }, { status: 503 });
		if (e instanceof SqlExecutionError) return json({ message: e.message }, { status: 400 });
		return json({ message: 'Query failed.' }, { status: 500 });
	}
};
