/**
 * POST /api/checkout/payment_intent
 *
 * Body:
 *   { "pricebookEntryIds": ["01u…", "01u…"] }
 *
 * Server-side price lookup (NEVER trust a client-submitted total) → Stripe
 * PaymentIntent for the sum → return clientSecret for the embedded Stripe
 * Payment Element to confirm.
 *
 * The PaymentIntent metadata carries everything the eventual webhook needs to
 * match a successful payment back to local records:
 *   - user_id
 *   - account_id (Salesforce Account)
 *   - pricebook_entry_ids (comma-joined; Stripe metadata values are strings)
 *
 * NOTE: still no Stripe webhook handler. Until /api/stripe/webhook is built,
 * "payment succeeded" knowledge lives only with Stripe + the success page.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStripe } from '$lib/server/stripe';
import { getOrCreateStripeCustomer } from '$lib/server/stripe_customer';
import { getCatalogProduct, parseRecurringOptions, dueNow, balanceLater, type CatalogProduct } from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';
import { sql } from '$lib/server/db';
import { stripeFeeCents } from '$lib/server/payments/fees';

interface Body {
	pricebookEntryIds?: string[];
	storeId?: string | null;
	kind?: string | null;
	termMonths?: number | null;
	payOption?: string | null;
}

const MAX_LINE_ITEMS = 20;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'You must be signed in to check out.');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'Body must be JSON.');
	}

	const kind: 'service' | 'subscription' | 'recurring' =
		body.kind === 'subscription' ? 'subscription' : body.kind === 'recurring' ? 'recurring' : 'service';
	const recurring = kind === 'recurring' ? parseRecurringOptions(body.termMonths, body.payOption) : null;
	if (kind === 'recurring' && !recurring) throw error(400, 'Choose a valid term and payment option.');

	// NOT deduped — the same service can be purchased more than once in one
	// order (e.g. the same line item for several locations); each repeated id
	// becomes its own ContractLineItem and its own Case downstream.
	const ids: string[] = Array.isArray(body.pricebookEntryIds)
		? body.pricebookEntryIds.map((id) => id?.trim()).filter((id): id is string => !!id)
		: [];
	if (ids.length === 0) throw error(400, 'pricebookEntryIds is required.');
	if (ids.length > MAX_LINE_ITEMS) throw error(400, `Max ${MAX_LINE_ITEMS} items per checkout.`);
	if (kind === 'subscription' && ids.length > 1) {
		throw error(400, 'Only one subscription plan can be selected at a time.');
	}

	// Optional store — verify ownership before trusting it.
	let validatedStoreId: string | null = null;
	if (body.storeId) {
		const rows = await sql<{ id: string }[]>`
			SELECT s.id
			FROM stores s JOIN users u ON u.id = ${locals.user.id}
			WHERE s.id = ${body.storeId} AND s.account_id = u.account_id
			LIMIT 1
		`;
		if (rows[0]) validatedStoreId = rows[0].id;
	}

	// Look up every product server-side. Drop anything that disappeared from
	// the catalog (e.g. deactivated since the user added it to selection).
	const lookups = await Promise.all(ids.map((id) => getCatalogProduct(id, kind, recurring)));
	const products: CatalogProduct[] = [];
	const missing: string[] = [];
	lookups.forEach((p, i) => (p ? products.push(p) : missing.push(ids[i])));
	if (products.length === 0) throw error(404, 'Selected services are no longer available.');

	const currency = (products[0].currency || 'USD').toLowerCase();
	const totalCents = products.reduce(
		// Deposit products are charged their deposit now; the balance is billed separately on case completion.
		(sum, p) => sum + Math.round(dueNow(p) * 100),
		0
	);
	if (!Number.isFinite(totalCents) || totalCents < 50) {
		throw error(400, 'Order total is below the minimum charge amount.');
	}

	// Stripe's processing fee is passed on to the client (grossed up so we net the base price).
	const feeCents = stripeFeeCents(totalCents);
	const chargeCents = totalCents + feeCents;

	// Build a human-readable note that will appear in the Stripe dashboard
	// (PaymentIntent description) so support staff can quickly identify the
	// customer and the services without leaving Stripe.
	//
	// Format:
	//   Customer: <displayName> | SFDC Account: <sfdcAccountId> | Local user id: <id>
	//   Services:
	//     <pricebookEntryId> — <name>
	//     …
	const user = locals.user;

	// Reuse the account's Stripe Customer (create it once, on first purchase)
	// so repeat payments are attributed to the same Customer instead of each
	// creating an anonymous charge.
	const [accountRow] = await sql<{ account_id: string | null }[]>`
		SELECT account_id FROM users WHERE id = ${user.id} LIMIT 1
	`;
	let stripeCustomerId: string | undefined;
	if (accountRow?.account_id) {
		const customerResult = await getOrCreateStripeCustomer(
			accountRow.account_id,
			{ email: user.email, name: user.displayName },
			{ userId: user.id }
		);
		if (customerResult.ok) stripeCustomerId = customerResult.customerId;
	}

	const serviceLines = products
		.map((p) => `  ${p.pricebookEntryId} — ${p.name}`)
		.join('\n');
	const note = [
		`Customer: ${user.displayName} | SFDC Account: ${user.sfdcAccountId ?? 'n/a'} | Local user id: ${user.id}`,
		`Services:\n${serviceLines}`
	].join('\n');

	try {
		const intent = await getStripe().paymentIntents.create({
			amount: chargeCents,
			currency,
			automatic_payment_methods: { enabled: true },
			receipt_email: user.email,
			description: note,
			...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
			metadata: {
				user_id: user.id,
				account_id: user.sfdcAccountId ?? '',
				store_id: validatedStoreId ?? '',
				pricebook_entry_ids: products.map((p) => p.pricebookEntryId).join(','),
				base_cents: String(totalCents),
				fee_cents: String(feeCents),
				balance_cents: String(products.reduce((s, p) => s + Math.round(balanceLater(p) * 100), 0)),
				product_ids: products.map((p) => p.productId).join(','),
				kind,
				...(recurring ? { term_months: String(recurring.termMonths), pay_option: recurring.payOption } : {})
			}
		});

		return json({
			clientSecret: intent.client_secret,
			amount: chargeCents,
			baseCents: totalCents,
			feeCents,
			currency,
			itemCount: products.length,
			missing
		});
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'stripe.payment_intent',
			operation: 'create',
			userId: user.id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: {
				ids,
				totalCents,
				currency,
				itemCount: products.length
			}
		});
		throw error(502, 'Could not start payment. Please try again.');
	}
};
