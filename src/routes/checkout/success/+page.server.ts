/**
 * Stripe success landing.
 *
 *  - New flow (embedded Payment Element): Stripe redirects here with
 *      ?payment_intent=pi_…&payment_intent_client_secret=…&redirect_status=succeeded
 *    We retrieve the PaymentIntent via Stripe, then create the local
 *    service_contracts row and the Salesforce ServiceContract + ContractLineItems.
 *
 *  - Checkout Session (`?session_id=cs_…`): the recurring-subscription flow, and
 *    stale hosted-Checkout redirects.
 *
 * Persistence lives in $lib/server/checkout/fulfillment, which the Stripe webhook
 * also runs (the customer may never get here). It is idempotent: refreshing this
 * page, or racing the webhook, creates nothing twice.
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getStripe } from '$lib/server/stripe';
import {
	snapshotPaymentIntent,
	persistContract,
	persistSubscriptionContract,
	type FulfillmentResult
} from '$lib/server/checkout/fulfillment';
import { logError, describeError } from '$lib/server/error_log';

export const load: PageServerLoad = async ({ url, locals }) => {
	const piId = url.searchParams.get('payment_intent');
	const sessionId = url.searchParams.get('session_id');
	if (!piId && !sessionId) throw error(400, 'Missing payment_intent or session_id query param.');

	const stripe = getStripe();

	try {
		if (piId) {
			const snapshot = await snapshotPaymentIntent(piId);
			const { pi } = snapshot;

			// Only create a contract when the PaymentIntent actually succeeded.
			let contractInfo: FulfillmentResult | null = null;
			if (pi.status === 'succeeded' && pi.metadata?.kind !== 'balance') {
				contractInfo = await persistContract(snapshot, locals.user?.id ?? null);
			}

			return {
				flow: 'payment_intent' as const,
				paymentStatus: pi.status,
				amountTotal: pi.amount,
				currency: pi.currency,
				customerEmail: pi.receipt_email,
				productName: snapshot.products[0]?.name ?? null,
				productCount: snapshot.products.length,
				products: snapshot.products.map((p) => p.name),
				contractInfo
			};
		}

		// Checkout Session path — used by the recurring-subscription flow
		// (/api/checkout/subscription) and kept for any stale hosted-Checkout
		// redirects.
		const session = await stripe.checkout.sessions.retrieve(sessionId!, {
			expand: ['line_items']
		});

		const contractInfo = await persistSubscriptionContract(session, { fallbackUserId: locals.user?.id ?? null });

		return {
			flow: 'checkout_session' as const,
			paymentStatus: session.payment_status,
			amountTotal: session.amount_total,
			currency: session.currency,
			customerEmail: session.customer_details?.email ?? null,
			productName: session.line_items?.data?.[0]?.description ?? null,
			productCount: session.line_items?.data?.length ?? 1,
			products: (session.line_items?.data ?? []).map((li) => li.description ?? 'Service'),
			contractInfo
		};
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'stripe.checkout',
			operation: 'retrieve_after_success',
			userId: locals.user?.id ?? null,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { paymentIntentId: piId, sessionId }
		});
		throw error(502, 'Could not load checkout confirmation.');
	}
};
