import { fail, type RequestEvent } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { listAccountContracts } from '$lib/server/admin/accounts';
import { fetchStripeCustomerLive } from '$lib/server/admin/integrations';
import { auditActor, clientIp } from '$lib/server/admin/guard';
import { roleHas } from '$lib/server/admin/permissions';
import { ActionError } from '$lib/server/admin/actions';
import { stripeUrl } from '$lib/server/admin/links';
import { importTransaction, lookupTransaction, pushPayment } from '$lib/server/admin/stripe_import';
import { sql } from '$lib/server/db';

export const load: PageServerLoad = async (event) => {
	const { account, accountId, staff } = await workspace(event, 'accounts.read');
	const payments = await sql<{
		stripe_payment_intent_id: string; kind: string; charged_cents: string; currency: string; paid_at: Date;
		sfdc_payment_name: string | null; sfdc_payment_id: string | null; sf_status: string; sf_error: string | null; imported_at: Date | null; has_contract: boolean;
	}[]>`
		SELECT stripe_payment_intent_id, kind, charged_cents::text AS charged_cents, currency, paid_at, sfdc_payment_name, sfdc_payment_id,
		       sf_status, sf_error, imported_at, (service_contract_id IS NOT NULL OR salesforce_contract_id IS NOT NULL) AS has_contract
		FROM stripe_payments WHERE account_id = ${accountId} ORDER BY paid_at DESC LIMIT 200`;
	return {
		contracts: await listAccountContracts(accountId),
		stripeCustomerId: account.stripe_customer_id,
		payments: payments.map((p) => ({ ...p, stripeUrl: stripeUrl('payment', p.stripe_payment_intent_id) })),
		canSync: roleHas(staff.role, 'accounts.update')
	};
};

/** Run an admin billing action, turning expected failures into form errors. */
async function guarded<T>(event: RequestEvent, run: (args: { ctx: Parameters<typeof importTransaction>[0]; accountId: string; data: FormData }) => Promise<T>) {
	const { staff, accountId } = await workspace(event, 'accounts.update');
	const data = await event.request.formData();
	try {
		return await run({ ctx: { actor: auditActor(staff), ip: clientIp(event) }, accountId, data });
	} catch (e) {
		if (e instanceof ActionError) return fail(e.status, { error: e.message });
		throw e;
	}
}

export const actions: Actions = {
	stripe: async (event) => {
		const { account } = await workspace(event, 'accounts.read');
		if (!account.stripe_customer_id) return fail(409, { stripe: null, error: 'No Stripe customer is linked.' });
		return { stripe: await fetchStripeCustomerLive(account.stripe_customer_id) };
	},
	lookup: (event) =>
		guarded(event, async ({ accountId, data }) => ({ preview: await lookupTransaction(accountId, String(data.get('transactionId') ?? '')) })),
	import: (event) =>
		guarded(event, async ({ ctx, accountId, data }) => ({
			ok: await importTransaction(ctx, accountId, String(data.get('transactionId') ?? ''), String(data.get('reason') ?? ''), data.get('confirmOwner') === 'on')
		})),
	push: (event) =>
		guarded(event, async ({ ctx, accountId, data }) => ({
			ok: await pushPayment(ctx, accountId, String(data.get('paymentIntentId') ?? ''), String(data.get('reason') ?? ''))
		}))
};
