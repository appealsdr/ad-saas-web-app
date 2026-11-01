import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { listAccountContracts } from '$lib/server/admin/accounts';
import { fetchStripeCustomerLive } from '$lib/server/admin/integrations';

export const load: PageServerLoad = async (event) => {
	const { account, accountId } = await workspace(event, 'accounts.read');
	return { contracts: await listAccountContracts(accountId), stripeCustomerId: account.stripe_customer_id };
};

export const actions: Actions = {
	stripe: async (event) => {
		const { account } = await workspace(event, 'accounts.read');
		if (!account.stripe_customer_id) return fail(409, { stripe: null, error: 'No Stripe customer is linked.' });
		return { stripe: await fetchStripeCustomerLive(account.stripe_customer_id) };
	}
};
