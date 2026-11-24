/**
 * Kill switches for the AI connector (/mcp + OAuth) — AD-1969.
 *  - global:  platform_flags('mcp_enabled'); TRUE = running. Emergency stop for everyone.
 *  - account: accounts.mcp_enabled; FALSE by default, enabled per account by a platform admin.
 * Fails CLOSED: if either lookup errors (e.g. migration 042 not applied), the connector is treated as off.
 */
import { sql } from '../db';

export type McpAvailability = { ok: true } | { ok: false; reason: 'global' | 'account' };

export async function getGlobalMcpEnabled(): Promise<boolean> {
	try {
		const [r] = await sql<{ bool_value: boolean }[]>`SELECT bool_value FROM platform_flags WHERE key = 'mcp_enabled'`;
		return r?.bool_value === true;
	} catch {
		return false;
	}
}

export async function setGlobalMcpEnabled(enabled: boolean, actorRef: string): Promise<void> {
	await sql`
		INSERT INTO platform_flags (key, bool_value, updated_by_ref) VALUES ('mcp_enabled', ${enabled}, ${actorRef})
		ON CONFLICT (key) DO UPDATE SET bool_value = EXCLUDED.bool_value, updated_at = now(), updated_by_ref = EXCLUDED.updated_by_ref`;
}

export async function getAccountMcpEnabled(accountId: string): Promise<boolean> {
	try {
		const [r] = await sql<{ mcp_enabled: boolean }[]>`SELECT mcp_enabled FROM accounts WHERE id = ${accountId}`;
		return r?.mcp_enabled === true;
	} catch {
		return false;
	}
}

export async function mcpAvailable(accountId: string): Promise<McpAvailability> {
	if (!(await getGlobalMcpEnabled())) return { ok: false, reason: 'global' };
	if (!(await getAccountMcpEnabled(accountId))) return { ok: false, reason: 'account' };
	return { ok: true };
}
