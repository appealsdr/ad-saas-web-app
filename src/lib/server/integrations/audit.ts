/**
 * Integration audit trail (integration_audit_events). Every API request that
 * resolved to an integration is recorded against that exact integration +
 * credential. Never pass credentials, Authorization headers, message bodies or
 * file contents here — metadata is also run through the shared redactor.
 */
import { sql } from '../db';
import { redactJson } from '../admin/redact';

export interface IntegrationAuditInput {
	eventType?: 'api_request' | 'config';
	integrationId: string | null;
	integrationName?: string | null;
	credentialId?: string | null;
	accountId?: string | null;
	defaultUserId?: string | null;
	requiredPermission?: string | null;
	operation: string;
	resourceType?: string | null;
	resourceId?: string | null;
	outcome: string;
	httpStatus?: number | null;
	errorCode?: string | null;
	requestId?: string | null;
	sourceIp?: string | null;
	durationMs?: number | null;
	metadata?: Record<string, unknown> | null;
}

function inet(ip: string | null | undefined): string | null {
	return ip && /^[0-9a-fA-F:.]+$/.test(ip.trim()) ? ip.trim() : null;
}

/** Best-effort for API requests: an audit write failure must not turn a served request into an error. */
export async function recordIntegrationEvent(e: IntegrationAuditInput): Promise<void> {
	try {
		const meta = e.metadata ? redactJson(e.metadata) : null;
		await sql`
			INSERT INTO integration_audit_events (
				event_type, integration_client_id, integration_name, credential_id, account_id, default_user_id,
				required_permission, operation, resource_type, resource_id, outcome, http_status, error_code,
				request_id, source_ip, duration_ms, metadata
			) VALUES (
				${e.eventType ?? 'api_request'}, ${e.integrationId}, ${e.integrationName ?? null}, ${e.credentialId ?? null},
				${e.accountId ?? null}, ${e.defaultUserId ?? null}, ${e.requiredPermission ?? null}, ${e.operation},
				${e.resourceType ?? null}, ${e.resourceId ?? null}, ${e.outcome}, ${e.httpStatus ?? null}, ${e.errorCode ?? null},
				${e.requestId ?? null}, ${inet(e.sourceIp)}, ${e.durationMs ?? null},
				${meta ? sql.json(meta as Parameters<typeof sql.json>[0]) : null}
			)
		`;
	} catch (err) {
		console.error('integration audit: failed to record event', e.operation, err instanceof Error ? err.message : err);
	}
}

export interface AuditRow {
	id: string;
	occurred_at: Date;
	event_type: string;
	integration_client_id: string | null;
	integration_name: string | null;
	credential_id: string | null;
	required_permission: string | null;
	operation: string;
	resource_type: string | null;
	resource_id: string | null;
	outcome: string;
	http_status: number | null;
	error_code: string | null;
	request_id: string | null;
	source_ip: string | null;
	duration_ms: number | null;
}

/** Account-scoped audit activity, optionally narrowed to one integration. */
export async function listIntegrationActivity(accountId: string, integrationId: string | null, limit = 50): Promise<AuditRow[]> {
	return sql<AuditRow[]>`
		SELECT id, occurred_at, event_type, integration_client_id, integration_name, credential_id,
		       required_permission, operation, resource_type, resource_id, outcome, http_status, error_code,
		       request_id, host(source_ip) AS source_ip, duration_ms
		FROM integration_audit_events
		WHERE account_id = ${accountId}
		  ${integrationId ? sql`AND integration_client_id = ${integrationId}` : sql``}
		ORDER BY occurred_at DESC
		LIMIT ${Math.min(Math.max(limit, 1), 200)}
	`;
}
