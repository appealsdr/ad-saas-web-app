/**
 * ⚠ DEPRECATED — Stripe Checkout Session redirect flow.
 *
 * Replaced by /api/checkout/payment_intent + embedded Stripe Payment Element
 * on /checkout/payment. Kept here (commented out) for reference; remove after
 * the new flow has been in production for a release or two.
 *
 * Behavior was: POST { pricebookEntryId, kind } → Stripe Checkout Session
 * (hosted page) → redirect user to session.url.
 */
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async () => {
	throw error(410, 'This endpoint has been replaced by /api/checkout/payment_intent.');
};

/* ── original implementation (kept for reference) ─────────────────────
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStripe, getReturnBaseUrl } from '$lib/server/stripe';
import { getCatalogProduct } from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';

interface CheckoutRequest {
	pricebookEntryId?: string;
	kind?: 'service' | 'subscription';
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'You must be signed in to check out.');
	let body: CheckoutRequest;
	try { body = (await request.json()) as CheckoutRequest; }
	catch { throw error(400, 'Body must be JSON.'); }

	const pricebookEntryId = body.pricebookEntryId?.trim();
	const kind = body.kind === 'subscription' ? 'subscription' : 'service';
	if (!pricebookEntryId) throw error(400, 'pricebookEntryId is required.');

	const product = await getCatalogProduct(pricebookEntryId, kind);
	if (!product) throw error(404, 'That product is not available right now.');

	const unitAmount = Math.round(product.unitPrice * 100);
	if (!Number.isFinite(unitAmount) || unitAmount < 50) {
		throw error(400, 'Invalid product price.');
	}

	const baseUrl = getReturnBaseUrl();
	const stripe = getStripe();

	try {
		const session = await stripe.checkout.sessions.create({
			mode: kind === 'subscription' ? 'subscription' : 'payment',
			line_items: [{
				quantity: 1,
				price_data: {
					currency: product.currency.toLowerCase(),
					product_data: {
						name: product.name,
						description: product.description ?? undefined,
						metadata: {
							sfdc_product_id: product.productId,
							sfdc_pricebook_entry_id: product.pricebookEntryId
						}
					},
					unit_amount: unitAmount,
					...(kind === 'subscription' ? { recurring: { interval: 'month' as const } } : {})
				}
			}],
			customer_email: locals.user.email,
			success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
			cancel_url: `${baseUrl}/services`,
			metadata: {
				user_id: locals.user.id,
				account_id: locals.user.sfdcAccountId ?? '',
				pricebook_entry_id: product.pricebookEntryId,
				product_id: product.productId,
				kind
			}
		});
		if (!session.url) throw new Error('Stripe did not return a Checkout URL.');
		return json({ url: session.url });
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'stripe.checkout',
			operation: 'create_session',
			userId: locals.user.id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { kind, pricebookEntryId, productName: product.name, unitAmount }
		});
		throw error(502, 'Could not start checkout. Please try again.');
	}
};
─────────────────────────────────────────────────────────────────────── */
