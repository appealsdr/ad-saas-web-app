import type { PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { accountContracts } from '$lib/server/admin/billing';
import { salesforceUrl, stripeUrl } from '$lib/server/admin/links';

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'accounts.read');
	const { contracts, paymentsError } = await accountContracts(accountId);
	const payments = await Promise.all(
		contracts.flatMap((c) => c.payments.map(async (p) => ({ ...p, sfUrl: await salesforceUrl('Payment__c', p.sfId), stripeUrl: stripeUrl('payment', p.stripePi) })))
	);
	payments.sort((a, b) => b.date.localeCompare(a.date));
	return { payments, paymentsError };
};
