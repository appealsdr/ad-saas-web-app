/**
 * POST /api/payments/:paymentId/fee   { intentId, method }
 *
 * The client changed payment method in the Payment Element: re-price the PaymentIntent with that method's Stripe
 * fee and return the new breakdown. Amounts are derived server-side from the intent metadata.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { getOwnedPayment, repriceIntentForMethod, BalanceError } from '$lib/server/payments/balance';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) throw error(401, 'Sign in required.');
	const body = (await request.json().catch(() => null)) as { intentId?: string; method?: string } | null;
	if (!body?.intentId || !/^pi_[A-Za-z0-9]+$/.test(body.intentId)) throw error(400, 'intentId is required.');
	const [u] = await sql<{ account_id: string | null }[]>`SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1`;
	if (!u?.account_id) throw error(403, 'No account.');
	try {
		const owned = await getOwnedPayment(u.account_id, params.paymentId);
		if (!owned) throw error(404, 'Payment not found.');
		const fee = await repriceIntentForMethod(body.intentId, u.account_id, body.method);
		return json({ fee });
	} catch (e) {
		if (e instanceof BalanceError) throw error(e.status, e.message);
		if (e && typeof e === 'object' && 'status' in e) throw e;
		throw error(502, 'Could not update the fee. Please try again.');
	}
};
