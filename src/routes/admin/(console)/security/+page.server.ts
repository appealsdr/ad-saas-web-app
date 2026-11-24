/** Admin → Security (AD-1969): AI-connector kill switch, security alerts, connection overview. */
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { requireStaff, auditActor, clientIp } from '$lib/server/admin/guard';
import { roleHas } from '$lib/server/admin/permissions';
import { recordAudit } from '$lib/server/admin/audit';
import { getGlobalMcpEnabled, setGlobalMcpEnabled } from '$lib/server/mcp/killswitch';
import { listAlerts, acknowledgeAlert, raiseAlert } from '$lib/server/security/alerts';
import { revokeAllGrants } from '$lib/server/oauth/core';

export const load: PageServerLoad = async (event) => {
	const staff = requireStaff(event, 'logs.read');
	const [alerts, stats] = await Promise.all([
		listAlerts({ limit: 100 }),
		sql<{ accounts_enabled: number; active_connections: number }[]>`
			SELECT (SELECT count(*) FROM accounts WHERE mcp_enabled)::int AS accounts_enabled,
			       (SELECT count(*) FROM oauth_grants WHERE revoked_at IS NULL)::int AS active_connections`.catch(() => [{ accounts_enabled: 0, active_connections: 0 }])
	]).catch(() => [[], [{ accounts_enabled: 0, active_connections: 0 }]] as const);
	return {
		globalEnabled: await getGlobalMcpEnabled(),
		canManage: roleHas(staff.role, 'staff.manage'),
		alerts: alerts.map((a) => ({ ...a, created_at: a.created_at.toISOString(), acknowledged_at: a.acknowledged_at?.toISOString() ?? null })),
		stats: stats[0]
	};
};

export const actions: Actions = {
	/** Emergency stop / restart for the whole connector. Existing connections are kept on stop (they just get 503s); use "revoke all" to cut them. */
	set_global: async (event) => {
		const staff = requireStaff(event, 'staff.manage', { freshMfa: true });
		const enabled = (await event.request.formData()).get('enabled') === 'true';
		await setGlobalMcpEnabled(enabled, staff.email);
		await recordAudit({ actor: auditActor(staff), action: 'platform.mcp_global_toggle', targetType: 'platform', outcome: 'success', ip: clientIp(event), metadata: { enabled } });
		await raiseAlert({ kind: 'kill_switch_changed', severity: enabled ? 'info' : 'high', subjectType: 'platform', subjectId: 'mcp', dedupeSeconds: 1, message: `AI connector ${enabled ? 'RE-ENABLED' : 'STOPPED globally'} by ${staff.email}.` });
		return { ok: enabled ? 'AI connector is running.' : 'AI connector stopped for everyone.' };
	},
	revoke_all: async (event) => {
		const staff = requireStaff(event, 'staff.manage', { freshMfa: true });
		const n = await revokeAllGrants({}, 'revoked by platform admin (global)');
		await recordAudit({ actor: auditActor(staff), action: 'platform.mcp_revoke_all', targetType: 'platform', outcome: 'success', ip: clientIp(event), metadata: { revoked: n } });
		await raiseAlert({ kind: 'connections_revoked', severity: 'high', subjectType: 'platform', subjectId: 'mcp', dedupeSeconds: 1, message: `All ${n} AI connection(s) revoked by ${staff.email}.` });
		return { ok: `${n} connection(s) revoked.` };
	},
	ack: async (event) => {
		const staff = requireStaff(event, 'accounts.update');
		const id = String((await event.request.formData()).get('id') ?? '');
		if (!/^[0-9a-f-]{36}$/i.test(id)) return fail(400, { error: 'Bad alert id.' });
		await acknowledgeAlert(id, staff.email);
		return { ok: 'Acknowledged.' };
	}
};
