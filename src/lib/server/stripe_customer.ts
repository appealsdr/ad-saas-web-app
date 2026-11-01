/**
 * One Stripe Customer per local account, reused across every purchase
 * (one-off services and subscriptions alike) instead of an anonymous
 * PaymentIntent/Checkout Session per order.
 *
 * accounts.stripe_customer_id is the source of truth locally; it's mirrored
 * to Salesforce Account.Stripe_Customer_Id__c the first time it's created.
 */
import { getStripe } from './stripe';
import { sql } from './db';
import { updateSalesforceAccountStripeCustomerId } from './salesforce';
import { logError, describeError } from './error_log';

export type StripeCustomerResult =
	| { ok: true; customerId: string }
	| { ok: false; error: string };

export async function getOrCreateStripeCustomer(
	accountId: string,
	info: { email: string; name: string },
	context: { userId?: string } = {}
): Promise<StripeCustomerResult> {
	const [row] = await sql<{ stripe_customer_id: string | null; sfdc_account_id: string | null }[]>`
		SELECT stripe_customer_id, sfdc_account_id FROM accounts WHERE id = ${accountId} LIMIT 1
	`;
	if (!row) return { ok: false, error: 'Account not found.' };

	// Already have one — reuse it rather than creating a duplicate Customer.
	// Verify it exists in the current Stripe mode: an ID saved under test keys
	// is "No such customer" under live keys (and vice versa), as is one that
	// was deleted in the dashboard. In that case fall through and recreate.
	if (row.stripe_customer_id) {
		try {
			const existing = await getStripe().customers.retrieve(row.stripe_customer_id);
			if (!existing.deleted) return { ok: true, customerId: row.stripe_customer_id };
		} catch (e) {
			if ((e as { code?: string })?.code !== 'resource_missing') {
				const desc = describeError(e);
				await logError({
					source: 'stripe.customer',
					operation: 'retrieve',
					accountId,
					userId: context.userId,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: { accountId }
				});
				return { ok: false, error: desc.errorMessage };
			}
		}
	}

	try {
		const customer = await getStripe().customers.create({
			email: info.email,
			name: info.name,
			metadata: { account_id: accountId }
		});

		await sql`
			UPDATE accounts SET stripe_customer_id = ${customer.id}
			WHERE id = ${accountId}
		`;

		if (row.sfdc_account_id) {
			await updateSalesforceAccountStripeCustomerId(row.sfdc_account_id, customer.id, {
				accountId,
				userId: context.userId
			});
		}

		return { ok: true, customerId: customer.id };
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'stripe.customer',
			operation: 'get_or_create',
			accountId,
			userId: context.userId,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { accountId }
		});
		return { ok: false, error: desc.errorMessage };
	}
}
