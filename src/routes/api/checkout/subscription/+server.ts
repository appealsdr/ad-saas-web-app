/**
 * POST /api/checkout/subscription
 *
 * Starts a real, recurring Stripe Subscription (unlike the one-off service
 * flow, which is a single PaymentIntent). Uses Stripe Checkout in
 * `mode: 'subscription'` — Stripe hosts the payment page and keeps billing
 * the customer automatically every term, which the app never had before
 * (previously "subscription" only meant a 12-month local/Salesforce
 * contract paid once).
 *
 * Body: { "pricebookEntryId": "01u…" } — the subscription belongs to the ACCOUNT
 * and covers every store on it.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStripe } from '$lib/server/stripe';
import { getOrCreateStripeCustomer } from '$lib/server/stripe_customer';
import { getCatalogProduct } from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';
import { sql } from '$lib/server/db';

interface Body {
	pricebookEntryId?: string;
}

export const POST: RequestHandler = async ({ request, locals, url }) => {
	if (!locals.user) throw error(401, 'You must be signed in to check out.');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'Body must be JSON.');
	}

	const pricebookEntryId = body.pricebookEntryId?.trim();
	if (!pricebookEntryId) throw error(400, 'pricebookEntryId is required.');

	const product = await getCatalogProduct(pricebookEntryId, 'subscription');
	if (!product) throw error(404, 'Selected plan is no longer available.');

	const [accountRow] = await sql<{ account_id: string | null }[]>`
		SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1
	`;
	if (!accountRow?.account_id) throw error(400, 'User has no account.');

	const customerResult = await getOrCreateStripeCustomer(
		accountRow.account_id,
		{ email: locals.user.email, name: locals.user.displayName },
		{ userId: locals.user.id }
	);
	if (!customerResult.ok) {
		throw error(502, `Could not set up billing: ${customerResult.error}`);
	}

	// The incoming request's own origin is always correct for where the user
	// actually is — STRIPE_RETURN_URL/ORIGIN can silently fall back to
	// localhost in an environment where neither is configured.
	const origin = url.origin;

	try {
		const session = await getStripe().checkout.sessions.create({
			mode: 'subscription',
			customer: customerResult.customerId,
			line_items: [
				{
					price_data: {
						currency: (product.currency || 'USD').toLowerCase(),
						unit_amount: Math.round(product.unitPrice * 100),
						recurring: { interval: 'year' },
						product_data: {
							name: product.name,
							description: product.description ?? undefined
						}
					},
					quantity: 1
				}
			],
			success_url: `${origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${origin}/accounts/subscription`,
			metadata: {
				kind: 'subscription',
				user_id: locals.user.id,
				account_id: accountRow.account_id,
				pricebook_entry_id: product.pricebookEntryId,
				product_id: product.productId,
				pricebook2_id: product.pricebook2Id
			},
			subscription_data: {
				metadata: {
					kind: 'subscription',
					user_id: locals.user.id,
					account_id: accountRow.account_id,
						pricebook_entry_id: product.pricebookEntryId
				}
			}
		});

		if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
		return json({ url: session.url });
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'stripe.subscription_checkout',
			operation: 'create_session',
			userId: locals.user.id,
			accountId: accountRow.account_id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { pricebookEntryId }
		});
		throw error(502, 'Could not start subscription checkout. Please try again.');
	}
};
