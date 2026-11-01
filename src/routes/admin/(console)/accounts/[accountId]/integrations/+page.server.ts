import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { listAccountStores, listAccountSyncErrors, listAccountSyncState } from '$lib/server/admin/accounts';
import { fetchSalesforceAccountLive } from '$lib/server/admin/integrations';

export const load: PageServerLoad = async (event) => {
	const { account, accountId } = await workspace(event, 'accounts.read');
	const [stores, syncState, syncErrors] = await Promise.all([
		listAccountStores(accountId),
		listAccountSyncState(accountId),
		listAccountSyncErrors(accountId)
	]);
	return {
		links: { sfdcAccountId: account.sfdc_account_id, stripeCustomerId: account.stripe_customer_id },
		stores: stores.map((s) => ({ id: s.id, name: s.name, sfdc: s.sfdc_store_id, status: s.spapi_status, connectedAt: s.spapi_connected_at, lastError: s.spapi_last_error })),
		syncState,
		syncErrors,
		localAsOf: new Date().toISOString()
	};
};

export const actions: Actions = {
	salesforce: async (event) => {
		const { account, accountId } = await workspace(event, 'accounts.read');
		if (!account.sfdc_account_id) return fail(409, { sf: null, error: 'No Salesforce account is linked.' });
		return { sf: await fetchSalesforceAccountLive(account.sfdc_account_id, accountId) };
	}
};
