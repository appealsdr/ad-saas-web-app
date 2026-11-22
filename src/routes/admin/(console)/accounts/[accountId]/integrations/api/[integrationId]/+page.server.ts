import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { listAccountUsers } from '$lib/server/admin/accounts';
import { roleHas } from '$lib/server/admin/permissions';
import { auditActor, clientIp, isUuid } from '$lib/server/admin/guard';
import { ActionError } from '$lib/server/admin/actions';
import {
	getIntegration, issueCredential, listConfigEvents, listCredentials, revokeCredential, setIntegrationStatus, updateIntegration
} from '$lib/server/integrations/service';
import { listIntegrationActivity } from '$lib/server/integrations/audit';
import { PERMISSION_OPTIONS, parseIntegrationForm } from '$lib/server/integrations/form';

function idOr404(raw: string | undefined): string {
	if (!raw || !isUuid(raw)) throw error(404, 'Integration not found.');
	return raw;
}

export const load: PageServerLoad = async (event) => {
	const { staff, accountId } = await workspace(event, 'accounts.read');
	const id = idOr404(event.params.integrationId);
	// Scoped by account: another account's integration id is simply "not found".
	const integration = await getIntegration(accountId, id);
	if (!integration) throw error(404, 'Integration not found.');
	const [users, credentials, activity, configEvents] = await Promise.all([
		listAccountUsers(accountId), listCredentials(id), listIntegrationActivity(accountId, id, 50), listConfigEvents(accountId, id, 25)
	]);
	return {
		integration: {
			id: integration.id, name: integration.name, status: integration.status, defaultUserId: integration.default_user_id,
			permissions: integration.permissions, allowedIps: (integration.allowed_ip_ranges ?? []).join('\n'),
			rateLimitPerMinute: integration.rate_limit_per_minute, credentialTtlDays: integration.credential_ttl_days,
			rotationGraceHours: integration.rotation_grace_hours, pausedAt: integration.paused_at, pauseReason: integration.pause_reason,
			disabledAt: integration.disabled_at, disableReason: integration.disable_reason, lastUsedAt: integration.last_used_at
		},
		users: users.filter((u) => u.is_active || u.id === integration.default_user_id)
			.map((u) => ({ id: u.id, label: `${u.display_name || u.email} (${u.email})` })),
		permissionOptions: PERMISSION_OPTIONS,
		credentials, activity, configEvents,
		canManage: roleHas(staff.role, 'accounts.update')
	};
};

async function run<T>(fn: () => Promise<T>, ok: (r: T) => Record<string, unknown>) {
	try {
		return ok(await fn());
	} catch (e) {
		if (e instanceof ActionError) return fail(e.status, { error: e.message });
		throw e;
	}
}

export const actions: Actions = {
	save: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update', { freshMfa: true });
		const id = idOr404(event.params.integrationId);
		const input = parseIntegrationForm(await event.request.formData());
		input.copyPermissionsFromId = null; // copying is a create-time choice only
		return run(() => updateIntegration({ actor: auditActor(staff), ip: clientIp(event) }, accountId, id, input), (c) => ({ ok: `Saved (${c.join(', ')}).` }));
	},
	status: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update', { freshMfa: true });
		const id = idOr404(event.params.integrationId);
		const d = await event.request.formData();
		const action = String(d.get('action') ?? '');
		if (!['pause', 'resume', 'disable'].includes(action)) return fail(400, { error: 'Invalid request.' });
		return run(() => setIntegrationStatus({ actor: auditActor(staff), ip: clientIp(event) }, accountId, id, action as 'pause' | 'resume' | 'disable', String(d.get('reason') ?? '')), () => ({ ok: `Integration ${action === 'resume' ? 'resumed' : action === 'pause' ? 'paused' : 'disabled'}.` }));
	},
	issue: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update', { freshMfa: true });
		const id = idOr404(event.params.integrationId);
		const d = await event.request.formData();
		const rotate = d.get('mode') === 'rotate';
		return run(() => issueCredential({ actor: auditActor(staff), ip: clientIp(event) }, accountId, id, String(d.get('label') ?? ''), rotate), (r) => ({ newKey: r.rawKey, retired: r.retired, rotated: rotate }));
	},
	revoke: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update', { freshMfa: true });
		const id = idOr404(event.params.integrationId);
		const d = await event.request.formData();
		const credentialId = String(d.get('credentialId') ?? '');
		if (!isUuid(credentialId)) return fail(400, { error: 'Invalid credential.' });
		return run(() => revokeCredential({ actor: auditActor(staff), ip: clientIp(event) }, accountId, id, credentialId, String(d.get('reason') ?? '')), () => ({ ok: 'Credential revoked.' }));
	}
};
