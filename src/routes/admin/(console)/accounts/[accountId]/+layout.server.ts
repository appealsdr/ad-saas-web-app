import type { LayoutServerLoad } from './$types';
import { workspace, sanitizeFrom } from '$lib/server/admin/workspace';
import { accountSummary } from '$lib/server/admin/accounts';
import { sfExisting, sfState } from '$lib/server/admin/sf_sync';

export const load: LayoutServerLoad = async (event) => {
	const { account, accountId } = await workspace(event, 'accounts.read');
	const from = sanitizeFrom(event.url.searchParams.get('from'));
	const [summary, existing] = await Promise.all([accountSummary(accountId), sfExisting('Account', [account.sfdc_account_id])]);
	return {
		account: { id: account.id, name: account.name, email: account.email, sfdcAccountId: account.sfdc_account_id },
		sfState: sfState(account.sfdc_account_id, existing),
		stats: { users: summary.users, stores: summary.stores, connectedStores: summary.connected_stores, contracts: summary.contracts },
		from,
		backHref: `/admin/accounts${from ? '?' + from : ''}`
	};
};
