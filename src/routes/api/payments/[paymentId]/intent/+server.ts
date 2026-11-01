/**
 * POST /api/payments/:paymentId/intent
 *
 * Starts the Stripe payment for an EXISTING Salesforce balance Payment__c. Amount and description come from
 * that record; collectibility (Status__c = 'Request Payment') is re-checked here against Salesforce, never
 * trusted from the browser. Returns a Stripe client secret for the Payment Element.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { getOwnedPayment, createBalanceIntent, BalanceError } from '$lib/server/payments/balance';
import { getOrCreateStripeCustomer } from '$lib/server/stripe_customer';
import { logError, describeError } from '$lib/server/error_log';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Sign in required.');
	const [u] = await sql<{ account_id: string | null; role: string }[]>`SELECT account_id, role FROM users WHERE id = ${locals.user.id} LIMIT 1`;
	if (!u?.account_id) throw error(403, 'No account.');
	try {
		const owned = await getOwnedPayment(u.account_id, params.paymentId);
		if (!owned) throw error(404, 'Payment not found.');
		let customerId: string | undefined;
		const c = await getOrCreateStripeCustomer(u.account_id, { email: locals.user.email, name: locals.user.displayName }, { userId: locals.user.id });
		if (c.ok) customerId = c.customerId;
		const r = await createBalanceIntent(owned, { id: locals.user.id, email: locals.user.email, displayName: locals.user.displayName }, customerId);
		return json({ clientSecret: r.clientSecret, amount: r.amountCents, currency: r.currency });
	} catch (e) {
		if (e instanceof BalanceError) throw error(e.status, e.message);
		if (e && typeof e === 'object' && 'status' in e) throw e; // an HttpError from above
		const d = describeError(e);
		await logError({ source: 'payments.balance', operation: 'create_intent', userId: locals.user.id, accountId: u.account_id, errorMessage: d.errorMessage, stack: d.stack, context: { paymentId: params.paymentId } });
		throw error(502, 'Could not start the payment. Please try again.');
	}
};
