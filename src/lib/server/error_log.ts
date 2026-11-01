/**
 * Structured error logger backed by the `error_log` Postgres table.
 *
 * Design rules:
 *   - This logger MUST NEVER THROW. If the DB write itself fails, we
 *     console.error and move on — error logging should not break the request
 *     it's meant to observe.
 *   - The caller decides what goes in `context`. DO NOT pass passwords,
 *     access tokens, refresh tokens, PEM keys, or other secrets — this table
 *     ends up in backups, dumps, and probably an ops UI.
 *   - severity defaults to 'error'; pass 'warn' for things you want recorded
 *     but that are recoverable (e.g. queued-for-retry on a transient SF
 *     outage).
 *
 * Usage:
 *   import { logError } from '$lib/server/error_log';
 *
 *   await logError({
 *     source: 'salesforce.sync',
 *     operation: 'create_account',
 *     userId, accountId,
 *     sfdcObject: 'Account',
 *     errorCode: 'INVALID_FIELD',
 *     errorMessage: e.message,
 *     context: { payload: sanitized, attempt: 1 }
 *   });
 */
import { sql } from './db';
import { currentRequest } from './admin/request_context';
import { redactJson, redactString } from './admin/redact';

export interface ErrorLogEntry {
	source: string;                          // e.g. 'salesforce.sync', 'register'
	operation: string;                       // e.g. 'create_account', 'persist_ids'
	severity?: 'error' | 'warn';             // default 'error'
	userId?: string | null;
	accountId?: string | null;
	sfdcObject?: 'Account' | 'Contact' | string | null;
	errorCode?: string | null;
	errorMessage: string;
	context?: Record<string, unknown> | null;
	stack?: string | null;
	requestId?: string | null;               // defaults to the current request's id
}

export async function logError(entry: ErrorLogEntry): Promise<void> {
	try {
		// Correlate with the current request and redact secrets BEFORE storage.
		const ctx = currentRequest();
		const requestId = entry.requestId ?? ctx?.requestId ?? null;
		const accountId = entry.accountId ?? ctx?.accountId ?? null;
		const userId = entry.userId ?? null;
		const message = redactString(entry.errorMessage);
		const stack = entry.stack ? redactString(entry.stack) : null;
		const context = entry.context ? redactJson(entry.context) : null;
		await sql`
			INSERT INTO error_log (
				source, operation, severity,
				user_id, account_id,
				sfdc_object, error_code, error_message,
				context, stack, request_id
			)
			VALUES (
				${entry.source},
				${entry.operation},
				${entry.severity ?? 'error'},
				${userId},
				${accountId},
				${entry.sfdcObject ?? null},
				${entry.errorCode ?? null},
				${message},
				${context ? sql.json(context as Parameters<typeof sql.json>[0]) : null},
				${stack},
				${requestId}
			)
		`;
	} catch (e) {
		// Logger of last resort — at least leave breadcrumbs in stdout.
		console.error('error_log: failed to record error', {
			originalEntry: entry,
			logWriteError: e instanceof Error ? e.message : String(e)
		});
	}
}

/**
 * Pull an Error-shaped object into the loosely-typed fields we store. Centralizes
 * the "is this a SalesforceApiError vs Error vs string" branching at call sites.
 */
export function describeError(
	e: unknown
): { errorMessage: string; errorCode?: string; stack?: string } {
	if (e instanceof Error) {
		const code = (e as Error & { errorCode?: string }).errorCode;
		return { errorMessage: e.message, errorCode: code, stack: e.stack };
	}
	return { errorMessage: String(e) };
}
