/**
 * Security alerts (AD-1969). Stored in security_alerts, written to the error log, and (optionally) pushed to a webhook.
 *
 * Set SECURITY_ALERT_WEBHOOK_URL to a Slack-compatible incoming webhook ({ "text": "..." }) to get notified.
 * Alerts are de-duplicated: the same (kind, subject) is not raised again while an unacknowledged one is newer than `dedupeSeconds`.
 * Never put credentials, file contents or message text in `message` / `metadata`.
 */
import { sql } from '../db';
import { env } from '$env/dynamic/private';
import { logError } from '../error_log';
import { redactJson } from '../admin/redact';

export type AlertSeverity = 'info' | 'medium' | 'high';

export interface AlertInput {
	kind:
		| 'oauth_refresh_reuse' | 'oauth_code_reuse' | 'malware_upload' | 'mcp_repeated_denials'
		| 'mcp_high_volume' | 'kill_switch_changed' | 'connections_revoked';
	severity: AlertSeverity;
	message: string;
	accountId?: string | null;
	subjectType?: string | null;
	subjectId?: string | null;
	metadata?: Record<string, unknown> | null;
	dedupeSeconds?: number;
}

export async function raiseAlert(a: AlertInput): Promise<boolean> {
	try {
		const window = a.dedupeSeconds ?? 600;
		const [dupe] = await sql<{ id: string }[]>`
			SELECT id FROM security_alerts
			WHERE kind = ${a.kind} AND coalesce(subject_id, '') = ${a.subjectId ?? ''} AND acknowledged_at IS NULL
			  AND created_at > now() - (${window} * interval '1 second') LIMIT 1`;
		if (dupe) return false;
		const meta = a.metadata ? redactJson(a.metadata) : null;
		await sql`
			INSERT INTO security_alerts (kind, severity, account_id, subject_type, subject_id, message, metadata)
			VALUES (${a.kind}, ${a.severity}, ${a.accountId ?? null}, ${a.subjectType ?? null}, ${a.subjectId ?? null}, ${a.message},
			        ${meta ? sql.json(meta as Parameters<typeof sql.json>[0]) : null})`;
		await notify(a);
		return true;
	} catch (e) {
		// An alerting failure must never break the request that triggered it.
		console.error('security alert: failed to record', a.kind, e instanceof Error ? e.message : e);
		return false;
	}
}

async function notify(a: AlertInput): Promise<void> {
	await logError({
		source: 'security.alert', operation: a.kind, accountId: a.accountId ?? undefined,
		errorMessage: `[${a.severity}] ${a.message}`, context: { subjectType: a.subjectType, subjectId: a.subjectId }
	}).catch(() => {});
	const url = env.SECURITY_ALERT_WEBHOOK_URL;
	if (!url || !/^https:\/\//.test(url)) return;
	try {
		await fetch(url, {
			method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(4000),
			body: JSON.stringify({ text: `:rotating_light: [${a.severity.toUpperCase()}] ${a.kind}: ${a.message}` })
		});
	} catch { /* best effort */ }
}

export interface AlertRow {
	id: string; created_at: Date; kind: string; severity: AlertSeverity; account_id: string | null; account_name: string | null;
	subject_type: string | null; subject_id: string | null; message: string; acknowledged_at: Date | null; acknowledged_by: string | null;
}

export function listAlerts(opts: { openOnly?: boolean; limit?: number } = {}): Promise<AlertRow[]> {
	const limit = Math.min(opts.limit ?? 100, 500);
	return sql<AlertRow[]>`
		SELECT s.id, s.created_at, s.kind, s.severity, s.account_id, a.name AS account_name, s.subject_type, s.subject_id,
		       s.message, s.acknowledged_at, s.acknowledged_by
		FROM security_alerts s LEFT JOIN accounts a ON a.id = s.account_id
		WHERE ${opts.openOnly ? sql`s.acknowledged_at IS NULL` : sql`true`}
		ORDER BY s.created_at DESC LIMIT ${limit}`;
}

export async function acknowledgeAlert(id: string, actorRef: string): Promise<void> {
	await sql`UPDATE security_alerts SET acknowledged_at = now(), acknowledged_by = ${actorRef} WHERE id = ${id} AND acknowledged_at IS NULL`;
}
