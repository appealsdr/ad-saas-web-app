/**
 * Stripe returns here after a balance payment. We verify the PaymentIntent with Stripe (never trust the query),
 * apply it to the SAME Payment__c record, and go back to Payments. Safe to load repeatedly: applyBalancePaid
 * claims each PaymentIntent once.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getStripe } from '$lib/server/stripe';
import { sql } from '$lib/server/db';
import { applyBalancePaid } from '$lib/server/payments/balance';
import { logError, describeError } from '$lib/server/error_log';

export const load: PageServerLoad = async ({ url, params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const piId = url.searchParams.get('payment_intent');
	if (!piId) throw redirect(303, '/payments');
	try {
		const pi = await getStripe().paymentIntents.retrieve(piId);
		const [u] = await sql<{ account_id: string | null }[]>`SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1`;
		// Must be this user's account and this record.
		if (pi.metadata?.kind !== 'balance' || pi.metadata.payment_id !== params.paymentId || pi.metadata.account_id !== u?.account_id) {
			throw redirect(303, '/payments');
		}
		if (pi.status === 'succeeded') {
			await applyBalancePaid(pi);
			throw redirect(303, `/payments?paid=${encodeURIComponent(pi.metadata.payment_name || '1')}`);
		}
		throw redirect(303, `/payments?payment=${pi.status === 'processing' ? 'processing' : 'failed'}`);
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && 'location' in e) throw e; // a redirect
		const d = describeError(e);
		await logError({ source: 'payments.balance', operation: 'complete', userId: locals.user.id, errorMessage: d.errorMessage, stack: d.stack, context: { piId } });
		throw redirect(303, '/payments?payment=failed');
	}
};
