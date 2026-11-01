/**
 * POST /api/stripe/webhook
 *
 * Handles Stripe events that originate entirely on Stripe's side (Billing
 * Portal cancellation, automatic subscription renewal charges):
 *
 *  - customer.subscription.updated — the customer cancels from Stripe's hosted
 *    Billing Portal (see /api/checkout/billing-portal) but keeps access until the
 *    paid period ends. The contract stays ACTIVE; its end date is set to the Stripe
 *    period end (and pushed to Salesforce) and the app shows "Ends <date>".
 *
 *  - payment_intent.succeeded — a customer paid a deposit balance through the Pay button; the existing
 *    Payment__c is marked Paid with the Stripe details (never a new record; repeated events are no-ops).
 *
 *  - customer.subscription.deleted — the period ended (or immediate cancel). The
 *    contract is marked cancelled in the app and in Salesforce and the account no
 *    longer has an active subscription.
 *
 *  - invoice.payment_succeeded — Stripe auto-charges the customer every
 *    renewal term. The very first invoice for a subscription (billing_reason
 *    'subscription_create') is skipped here because that payment is already
 *    recorded when /checkout/success persists the initial contract; only
 *    later renewal invoices (billing_reason 'subscription_cycle') create a
 *    new Payment__c in Salesforce, linked to the existing ServiceContract.
 *
 * Configure in the Stripe dashboard: endpoint URL = <origin>/api/stripe/webhook,
 * events = customer.subscription.updated, customer.subscription.deleted,
 * invoice.payment_succeeded. Copy the
 * signing secret into STRIPE_WEBHOOK_SECRET.
 */
import { error, text } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStripe } from '$lib/server/stripe';
import { createPayment } from '$lib/server/salesforce';
import { handleSubscriptionEnded, handleSubscriptionUpdated } from '$lib/server/subscription_lifecycle';
import { applyBalancePaid } from '$lib/server/payments/balance';
import { sql } from '$lib/server/db';
import { logError, describeError } from '$lib/server/error_log';
import { env } from '$env/dynamic/private';

export const POST: RequestHandler = async ({ request }) => {
	const signature = request.headers.get('stripe-signature');
	const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
	if (!webhookSecret) {
		await logError({
			source: 'stripe.webhook',
			operation: 'config',
			severity: 'error',
			errorMessage: 'STRIPE_WEBHOOK_SECRET is not set — cannot verify incoming webhooks.'
		});
		throw error(500, 'Webhook not configured.');
	}
	if (!signature) throw error(400, 'Missing stripe-signature header.');

	const rawBody = await request.text();
	let event: import('stripe').Stripe.Event;
	try {
		event = getStripe().webhooks.constructEvent(rawBody, signature, webhookSecret);
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'stripe.webhook',
			operation: 'verify_signature',
			severity: 'warn',
			errorMessage: desc.errorMessage
		});
		throw error(400, `Webhook signature verification failed: ${desc.errorMessage}`);
	}

	// Insert-first idempotency guard — Stripe redelivers events (retries,
	// manual resend from the dashboard). A conflict here means we've already
	// processed this exact event, so skip straight to acknowledging it.
	const isNewEvent = await claimWebhookEvent(event.id, event.type);
	if (!isNewEvent) return text('ok');

	if (event.type === 'customer.subscription.deleted') {
		const subscription = event.data.object as import('stripe').Stripe.Subscription;
		await handleSubscriptionEnded(subscription.id);
	}

	if (event.type === 'customer.subscription.updated') {
		await handleSubscriptionUpdated(event.data.object as import('stripe').Stripe.Subscription);
	}

	// A deposit balance was paid: update the EXISTING Payment__c (idempotent with the return page).
	if (event.type === 'payment_intent.succeeded') {
		await applyBalancePaid(event.data.object as import('stripe').Stripe.PaymentIntent);
	}

	if (event.type === 'invoice.payment_succeeded') {
		const invoice = event.data.object as import('stripe').Stripe.Invoice;
		await handleInvoicePaymentSucceeded(invoice, event.id);
	}

	return text('ok');
};

/** Returns true the first time this event id is seen, false on a redelivery. */
async function claimWebhookEvent(eventId: string, eventType: string): Promise<boolean> {
	const inserted = await sql<{ stripe_event_id: string }[]>`
		INSERT INTO stripe_webhook_events (stripe_event_id, event_type)
		VALUES (${eventId}, ${eventType})
		ON CONFLICT (stripe_event_id) DO NOTHING
		RETURNING stripe_event_id
	`;
	return inserted.length > 0;
}

async function handleInvoicePaymentSucceeded(
	invoice: import('stripe').Stripe.Invoice,
	stripeEventId: string
): Promise<void> {
	// The first invoice on a new subscription is already recorded as a
	// Payment__c when /checkout/success persists the initial contract
	// (see createServiceContractWithLines -> createPayment). Only later
	// renewal charges need a webhook-driven Payment__c.
	if (invoice.billing_reason !== 'subscription_cycle') return;

	// Stripe's newer Invoice shape nests the subscription under
	// parent.subscription_details rather than a top-level `subscription` field.
	const subscriptionDetails = invoice.parent?.subscription_details;
	const subscriptionRef = subscriptionDetails?.subscription;
	const subscriptionId = typeof subscriptionRef === 'string' ? subscriptionRef : (subscriptionRef?.id ?? null);
	if (!subscriptionId) return;

	const [contract] = await sql<{
		id: string;
		account_id: string;
		sfdc_service_contract_id: string | null;
	}[]>`
		SELECT id, account_id, sfdc_service_contract_id
		FROM service_contracts
		WHERE stripe_subscription_id = ${subscriptionId}
		LIMIT 1
	`;
	if (!contract) {
		// No local record of this subscription (e.g. created outside this app).
		return;
	}
	if (!contract.sfdc_service_contract_id) {
		await logError({
			source: 'stripe.webhook',
			operation: 'invoice_payment_succeeded',
			severity: 'warn',
			accountId: contract.account_id,
			errorMessage: 'Renewal invoice paid but local contract has no Salesforce ServiceContract to link the payment to.',
			context: { subscriptionId, invoiceId: invoice.id, stripeEventId }
		});
		return;
	}

	// The PaymentIntent lives under the invoice's `payments` list now rather
	// than a top-level `payment_intent` field. Only populated when the
	// `payments` data is included on the event payload — configure the
	// webhook endpoint in Stripe to include it, or this falls back to the
	// invoice id below.
	const invoicePayment = invoice.payments?.data?.[0]?.payment;
	const paymentIntentRef = invoicePayment?.type === 'payment_intent' ? invoicePayment.payment_intent : null;
	const paymentIntentId = typeof paymentIntentRef === 'string' ? paymentIntentRef : (paymentIntentRef?.id ?? null);

	const result = await createPayment(
		{
			amount: invoice.amount_paid / 100,
			currency: (invoice.currency || 'usd').toUpperCase(),
			description: 'Subscription renewal',
			paymentType: 'Subscription Renewal',
			status: 'Paid',
			paidAt: invoice.status_transitions?.paid_at
				? new Date(invoice.status_transitions.paid_at * 1000)
				: new Date(),
			stripe: {
				// Fall back to the invoice id — Payment__c requires *some* Stripe
				// reference, and a $0 invoice (e.g. fully covered by a coupon)
				// won't always carry a payment_intent.
				paymentIntentId: paymentIntentId ?? invoice.id,
				eventId: stripeEventId
			},
			sfdcServiceContractId: contract.sfdc_service_contract_id
		},
		{ accountId: contract.account_id }
	);

	if (!result.ok) {
		await logError({
			source: 'stripe.webhook',
			operation: 'invoice_payment_succeeded',
			accountId: contract.account_id,
			errorMessage: `Failed to create renewal Payment__c: ${result.error}`,
			context: { subscriptionId, invoiceId: invoice.id, stripeEventId }
		});
	}
}
