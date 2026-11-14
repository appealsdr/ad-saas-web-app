/**
 * POST /api/checkout/fee   { intentId, method }
 *
 * Checkout counterpart of /api/payments/:id/fee — re-prices the PaymentIntent for the selected payment method.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { repriceIntentForMethod, BalanceError } from '$lib/server/payments/balance';

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'You must be signed in to check out.');
	const body = (await request.json().catch(() => null)) as { intentId?: string; method?: string } | null;
	if (!body?.intentId || !/^pi_[A-Za-z0-9]+$/.test(body.intentId)) throw error(400, 'intentId is required.');
	// Checkout intents carry the SFDC account id (may be empty for unlinked users); match on user_id instead.
	try {
		const fee = await repriceIntentForMethod(body.intentId, null, body.method, locals.user.id);
		return json({ fee });
	} catch (e) {
		if (e instanceof BalanceError) throw error(e.status, e.message);
		throw error(502, 'Could not update the fee. Please try again.');
	}
};
