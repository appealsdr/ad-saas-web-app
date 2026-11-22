import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { listAccountStores, listAccountSyncErrors, listAccountSyncState } from '$lib/server/admin/accounts';
import { fetchSalesforceAccountLive } from '$lib/server/admin/integrations';
import { roleHas } from '$lib/server/admin/permissions';
import { auditActor, clientIp, isUuid } from '$lib/server/admin/guard';
import { ActionError } from '$lib/server/admin/actions';
import { listIntegrations, listConfigEvents, pauseAllIntegrations, setIntegrationStatus } from '$lib/server/integrations/service';
import { listIntegrationActivity } from '$lib/server/integrations/audit';
import { INTEGRATION_PERMISSIONS } from '$lib/server/integrations/permissions';

export const load: PageServerLoad = async (event) => {
	const { staff, account, accountId } = await workspace(event, 'accounts.read');
	const filterRaw = event.url.searchParams.get('integration');
	const filter = filterRaw && isUuid(filterRaw) ? filterRaw : null;
	const [stores, syncState, syncErrors, integrations, activity, configEvents] = await Promise.all([
		listAccountStores(accountId),
		listAccountSyncState(accountId),
		listAccountSyncErrors(accountId),
		listIntegrations(accountId),
		listIntegrationActivity(accountId, filter, 50),
		listConfigEvents(accountId, filter, 25)
	]);
	return {
		links: { sfdcAccountId: account.sfdc_account_id, stripeCustomerId: account.stripe_customer_id },
		stores: stores.map((s) => ({ id: s.id, name: s.name, sfdc: s.sfdc_store_id, status: s.spapi_status, connectedAt: s.spapi_connected_at, lastError: s.spapi_last_error })),
		syncState,
		syncErrors,
		localAsOf: new Date().toISOString(),
		// Never includes a credential hash or secret — list shows prefix-free metadata only.
		apiIntegrations: integrations.map((i) => ({
			id: i.id, name: i.name, description: i.description, status: i.status, defaultUser: i.default_user_name || i.default_user_email,
			permissionCount: i.permissions.length, permissionTotal: INTEGRATION_PERMISSIONS.length,
			lastUsedAt: i.last_used_at, activeCredentials: i.active_credentials
		})),
		activity,
		configEvents,
		filter,
		canManage: roleHas(staff.role, 'accounts.update')
	};
};

export const actions: Actions = {
	salesforce: async (event) => {
		const { account, accountId } = await workspace(event, 'accounts.read');
		if (!account.sfdc_account_id) return fail(409, { sf: null, error: 'No Salesforce account is linked.' });
		return { sf: await fetchSalesforceAccountLive(account.sfdc_account_id, accountId) };
	},

	/** Pause / resume exactly ONE integration (the row's). */
	status: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update', { freshMfa: true });
		const d = await event.request.formData();
		const id = String(d.get('integrationId') ?? '');
		const action = String(d.get('action') ?? '');
		if (!isUuid(id) || !['pause', 'resume', 'disable'].includes(action)) return fail(400, { apiError: 'Invalid request.' });
		try {
			await setIntegrationStatus({ actor: auditActor(staff), ip: clientIp(event) }, accountId, id, action as 'pause' | 'resume' | 'disable', String(d.get('reason') ?? ''));
			return { apiOk: `Integration ${action === 'resume' ? 'resumed' : action === 'pause' ? 'paused' : 'disabled'}.` };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { apiError: e.message });
			throw e;
		}
	},

	/** Account-wide emergency stop — its own confirmation, never triggered by a single-integration pause. */
	pauseAll: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update', { freshMfa: true });
		const d = await event.request.formData();
		try {
			const ids = await pauseAllIntegrations({ actor: auditActor(staff), ip: clientIp(event) }, accountId, String(d.get('reason') ?? ''), String(d.get('confirm') ?? ''));
			return { apiOk: `Paused ${ids.length} active integration${ids.length === 1 ? '' : 's'}.` };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { apiError: e.message });
			throw e;
		}
	}
};
