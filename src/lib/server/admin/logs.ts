/**
 * Stored-log reader for the admin UI: error_log, activity_log and
 * admin_audit_events, with stable (timestamp, id) cursor pagination.
 *
 * Attribution: account_id is shown ONLY when the row itself carries one.
 * Historical rows without account_id are 'unattributed' — we never infer an
 * account from the user's CURRENT account.
 *
 * Redaction: legacy rows are redacted again here (message, stack, nested JSON)
 * even though new writes are redacted at write time.
 */
import { sql } from '../db';
import { redactString, redactValue } from './redact';

export type LogSource = 'all' | 'error' | 'activity' | 'audit';

export interface LogFilters {
	source: LogSource;
	from?: Date | null;
	to?: Date | null;
	severity?: string | null; // error_log only
	event?: string | null; // operation (error), event_type (activity), action (audit)
	actorUserId?: string | null;
	/** uuid, or 'unattributed' for rows without an account */
	accountId?: string | null;
	requestId?: string | null;
	text?: string | null;
	cursor?: string | null;
	limit?: number;
}

export interface LogEntry {
	source: 'error' | 'activity' | 'audit';
	id: string;
	ts: string; // ISO-8601 UTC
	severity: string | null;
	event: string;
	origin: string | null;
	actorUserId: string | null;
	actorRef: string | null;
	accountId: string | null;
	requestId: string | null;
	message: string | null;
	stack: string | null;
	code: string | null;
	details: unknown; // redacted
	missing: string[]; // explicit reasons for absent fields
}

interface Cursor {
	t: string;
	i: string;
}

export function encodeCursor(c: Cursor): string {
	return Buffer.from(JSON.stringify(c)).toString('base64url');
}
export function decodeCursor(s: string | null | undefined): Cursor | null {
	if (!s) return null;
	try {
		const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
		if (typeof c.t !== 'string' || typeof c.i !== 'string') return null;
		if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(c.t)) return null;
		if (!/^[0-9a-f-]{36}$/i.test(c.i)) return null;
		return c;
	} catch {
		return null;
	}
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIMIT = 100;
const MAX_FIELD = 20_000;

interface Raw {
	source: 'error' | 'activity' | 'audit';
	id: string;
	ts_text: string;
	severity: string | null;
	event: string;
	origin: string | null;
	actor_user_id: string | null;
	actor_ref: string | null;
	account_id: string | null;
	request_id: string | null;
	message: string | null;
	stack: string | null;
	code: string | null;
	details: unknown;
}

const TS_TEXT = (col: string) => sql`to_char(${sql(col)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export async function queryLogs(f: LogFilters): Promise<{ entries: LogEntry[]; nextCursor: string | null; limit: number }> {
	const limit = Math.min(Math.max(f.limit ?? 50, 1), MAX_LIMIT);
	const cur = decodeCursor(f.cursor);
	const curTs = cur?.t ?? null;
	const curId = cur?.i ?? null;
	const text = f.text?.trim() ? `%${f.text.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
	const actor = f.actorUserId && UUID.test(f.actorUserId) ? f.actorUserId : null;
	const unattributed = f.accountId === 'unattributed';
	const account = f.accountId && UUID.test(f.accountId) ? f.accountId : null;
	const badActor = !!f.actorUserId && !actor;
	const badAccount = !!f.accountId && !unattributed && !account;
	const from = f.from ?? null;
	const to = f.to ?? null;
	const event = f.event?.trim() || null;
	const request = f.requestId?.trim() || null;
	const severity = f.severity?.trim() || null;
	const wants = (s: 'error' | 'activity' | 'audit') => f.source === 'all' || f.source === s;

	const branches = [];

	if (wants('error') && !badActor && !badAccount) {
		branches.push(sql`(
			SELECT 'error'::text AS source, e.id, ${TS_TEXT('created_at')} AS ts_text, e.created_at AS ts,
			       e.severity, e.operation AS event, e.source AS origin,
			       e.user_id AS actor_user_id, NULL::text AS actor_ref, e.account_id, e.request_id,
			       e.error_message AS message, e.stack, e.error_code AS code, e.context AS details
			FROM error_log e
			WHERE (${from}::timestamptz IS NULL OR e.created_at >= ${from})
			  AND (${to}::timestamptz IS NULL OR e.created_at < ${to})
			  AND (${severity}::text IS NULL OR e.severity = ${severity})
			  AND (${event}::text IS NULL OR e.operation = ${event})
			  AND (${actor}::uuid IS NULL OR e.user_id = ${actor})
			  AND (${account}::uuid IS NULL OR e.account_id = ${account})
			  AND (NOT ${unattributed} OR e.account_id IS NULL)
			  AND (${request}::text IS NULL OR e.request_id = ${request})
			  AND (${text}::text IS NULL OR e.error_message ILIKE ${text} OR e.operation ILIKE ${text} OR e.source ILIKE ${text})
			  AND (${curTs}::timestamptz IS NULL OR (e.created_at, e.id) < (${curTs}::timestamptz, ${curId}::uuid))
			ORDER BY e.created_at DESC, e.id DESC
			LIMIT ${limit + 1}
		)`);
	}
	if (wants('activity') && !severity && !badActor && !badAccount) {
		branches.push(sql`(
			SELECT 'activity'::text AS source, a.id, ${TS_TEXT('created_at')} AS ts_text, a.created_at AS ts,
			       NULL::text AS severity, a.event_type AS event, NULL::text AS origin,
			       a.user_id AS actor_user_id, NULL::text AS actor_ref, a.account_id, a.request_id,
			       NULL::text AS message, NULL::text AS stack, NULL::text AS code, a.event_data AS details
			FROM activity_log a
			WHERE (${from}::timestamptz IS NULL OR a.created_at >= ${from})
			  AND (${to}::timestamptz IS NULL OR a.created_at < ${to})
			  AND (${event}::text IS NULL OR a.event_type = ${event})
			  AND (${actor}::uuid IS NULL OR a.user_id = ${actor})
			  AND (${account}::uuid IS NULL OR a.account_id = ${account})
			  AND (NOT ${unattributed} OR a.account_id IS NULL)
			  AND (${request}::text IS NULL OR a.request_id = ${request})
			  AND (${text}::text IS NULL OR a.event_type ILIKE ${text})
			  AND (${curTs}::timestamptz IS NULL OR (a.created_at, a.id) < (${curTs}::timestamptz, ${curId}::uuid))
			ORDER BY a.created_at DESC, a.id DESC
			LIMIT ${limit + 1}
		)`);
	}
	if (wants('audit') && !severity && !badActor && !badAccount) {
		branches.push(sql`(
			SELECT 'audit'::text AS source, x.id, ${TS_TEXT('occurred_at')} AS ts_text, x.occurred_at AS ts,
			       NULL::text AS severity, x.action AS event, x.outcome AS origin,
			       x.actor_user_id, x.actor_ref, x.target_account_id AS account_id, x.request_id,
			       x.reason AS message, NULL::text AS stack, NULL::text AS code,
			       jsonb_strip_nulls(jsonb_build_object(
			         'target_type', x.target_type, 'target_id', x.target_id, 'actor_role', x.actor_role,
			         'ip', host(x.ip_address), 'metadata', x.metadata)) AS details
			FROM admin_audit_events x
			WHERE (${from}::timestamptz IS NULL OR x.occurred_at >= ${from})
			  AND (${to}::timestamptz IS NULL OR x.occurred_at < ${to})
			  AND (${event}::text IS NULL OR x.action = ${event})
			  AND (${actor}::uuid IS NULL OR x.actor_user_id = ${actor})
			  AND (${account}::uuid IS NULL OR x.target_account_id = ${account})
			  AND (NOT ${unattributed} OR x.target_account_id IS NULL)
			  AND (${request}::text IS NULL OR x.request_id = ${request})
			  AND (${text}::text IS NULL OR x.action ILIKE ${text} OR x.reason ILIKE ${text} OR x.actor_ref ILIKE ${text})
			  AND (${curTs}::timestamptz IS NULL OR (x.occurred_at, x.id) < (${curTs}::timestamptz, ${curId}::uuid))
			ORDER BY x.occurred_at DESC, x.id DESC
			LIMIT ${limit + 1}
		)`);
	}
	if (!branches.length) return { entries: [], nextCursor: null, limit };

	// Combine branches (each already ordered/limited so it can use its index).
	let union = branches[0];
	for (let i = 1; i < branches.length; i++) union = sql`${union} UNION ALL ${branches[i]}`;

	const rows = await sql<(Raw & { ts: Date })[]>`
		SELECT * FROM (${union}) u ORDER BY u.ts DESC, u.id DESC LIMIT ${limit + 1}
	`;
	const page = rows.slice(0, limit);
	const last = page[page.length - 1];
	const nextCursor = rows.length > limit && last ? encodeCursor({ t: last.ts_text, i: last.id }) : null;
	return { entries: page.map(toEntry), nextCursor, limit };
}

function cap(s: string | null): string | null {
	if (s == null) return s;
	const r = redactString(s);
	return r.length > MAX_FIELD ? r.slice(0, MAX_FIELD) + '\n…[truncated]' : r;
}

function toEntry(r: Raw): LogEntry {
	const missing: string[] = [];
	if (!r.account_id) missing.push('No account recorded on this row (unattributed); not inferred from the user.');
	if (!r.request_id) missing.push('No request id (written before request correlation existed, or outside a request).');
	if (r.source === 'activity' && !r.actor_user_id) missing.push('No user recorded.');
	if (r.source === 'activity') missing.push('Activity rows have no message/severity/stack.');
	let details = r.details == null ? null : redactValue(r.details);
	const json = details == null ? '' : JSON.stringify(details);
	if (json.length > 50_000) details = { truncated: true, note: 'Details exceed 50 KB; truncated.', preview: json.slice(0, 2000) };
	return {
		source: r.source,
		id: r.id,
		ts: r.ts_text,
		severity: r.severity,
		event: r.event,
		origin: r.origin,
		actorUserId: r.actor_user_id,
		actorRef: r.actor_ref,
		accountId: r.account_id,
		requestId: r.request_id,
		message: cap(r.message),
		stack: cap(r.stack),
		code: r.code,
		details,
		missing
	};
}

export function parseLogFilters(params: URLSearchParams, fixedAccountId?: string): LogFilters {
	const src = params.get('source');
	const date = (k: string): Date | null => {
		const v = params.get(k);
		if (!v) return null;
		const d = new Date(v);
		return Number.isNaN(d.getTime()) ? null : d;
	};
	return {
		source: src === 'error' || src === 'activity' || src === 'audit' ? src : 'all',
		from: date('from'),
		to: date('to'),
		severity: params.get('severity') || null,
		event: params.get('event') || null,
		actorUserId: params.get('actor') || null,
		accountId: fixedAccountId ?? (params.get('account') || null),
		requestId: params.get('request') || null,
		text: params.get('q') || null,
		cursor: params.get('cursor') || null,
		limit: Number.parseInt(params.get('limit') ?? '50', 10) || 50
	};
}
