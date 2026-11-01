/**
 * Append-only admin audit trail (admin_audit_events).
 *
 * - Local mutations: call recordAudit(..., tx) INSIDE the same transaction as
 *   the mutation so a failed audit insert rolls the mutation back.
 * - Reads / external operations: recordAudit() on the shared pool; failures
 *   here for non-mutations are logged to console and never thrown when
 *   `bestEffort` is set.
 * - metadata is redacted before insert. Never pass raw SQL literals.
 */
import type { Sql, TransactionSql } from 'postgres';
import { sql } from '../db';
import { currentRequest } from './request_context';
import { redactJson } from './redact';

export interface AuditActor {
	userId: string | null;
	ref: string; // durable reference (email / 'cli:<user>' / 'anonymous')
	role?: string | null;
}

export interface AuditEntry {
	actor: AuditActor;
	action: string;
	targetType?: string | null;
	targetId?: string | null;
	targetAccountId?: string | null;
	outcome: 'success' | 'failure' | 'denied' | 'pending';
	reason?: string | null;
	ip?: string | null;
	requestId?: string | null;
	metadata?: Record<string, unknown> | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = Sql<any> | TransactionSql<any>;

export async function recordAudit(
	entry: AuditEntry,
	db: Db = sql,
	opts: { bestEffort?: boolean } = {}
): Promise<string | null> {
	const requestId = entry.requestId ?? currentRequest()?.requestId ?? null;
	const meta = entry.metadata ? redactJson(entry.metadata) : null;
	try {
		const run = db as Sql;
		const rows = await run<{ id: string }[]>`
			INSERT INTO admin_audit_events (
				actor_user_id, actor_ref, actor_role, action, target_type, target_id,
				target_account_id, outcome, reason, request_id, ip_address, metadata
			) VALUES (
				${entry.actor.userId}, ${entry.actor.ref}, ${entry.actor.role ?? null},
				${entry.action}, ${entry.targetType ?? null}, ${entry.targetId ?? null},
				${entry.targetAccountId ?? null}, ${entry.outcome}, ${entry.reason ?? null},
				${requestId}, ${validIp(entry.ip)},
				${meta ? run.json(meta as Parameters<typeof run.json>[0]) : null}
			)
			RETURNING id
		`;
		return rows[0]?.id ?? null;
	} catch (e) {
		if (opts.bestEffort) {
			console.error('admin audit: failed to record event', entry.action, e instanceof Error ? e.message : e);
			return null;
		}
		throw e;
	}
}

function validIp(ip: string | null | undefined): string | null {
	if (!ip) return null;
	return /^[0-9a-fA-F:.]+$/.test(ip) ? ip : null;
}
