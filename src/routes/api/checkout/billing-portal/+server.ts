/**
 * POST /api/checkout/billing-portal
 *
 * "Cancel subscription" hands off to Stripe's own hosted Billing Portal
 * rather than a custom cancel UI — the customer manages/cancels their
 * subscription there, and Stripe's `customer.subscription.deleted` webhook
 * (see /api/stripe/webhook) is what actually marks the contract cancelled
 * here and in Salesforce once they do.
 *
 * Body: {} — returns to the account subscription page.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStripe } from '$lib/server/stripe';
import { sql } from '$lib/server/db';
import { logError, describeError } from '$lib/server/error_log';

export const POST: RequestHandler = async ({ locals, url }) => {
	if (!locals.user) throw error(401, 'You must be signed in.');

	const [row] = await sql<{ stripe_customer_id: string | null }[]>`
		SELECT a.stripe_customer_id
		FROM users u JOIN accounts a ON a.id = u.account_id
		WHERE u.id = ${locals.user.id}
		LIMIT 1
	`;
	if (!row?.stripe_customer_id) {
		throw error(400, 'No billing account found for this user yet — nothing to manage.');
	}

	// The incoming request's own origin is always correct for where the user
	// actually is — STRIPE_RETURN_URL/ORIGIN can silently fall back to
	// localhost in an environment where neither is configured.
	const origin = url.origin;
	const returnUrl = `${origin}/accounts/subscription`;

	try {
		const portalSession = await getStripe().billingPortal.sessions.create({
			customer: row.stripe_customer_id,
			return_url: returnUrl
		});
		return json({ url: portalSession.url });
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'stripe.billing_portal',
			operation: 'create_session',
			userId: locals.user.id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
		});
		throw error(502, 'Could not open subscription management. Please try again.');
	}
};
