/**
 * GET /api/payments/:paymentId/documents → { receiptUrl, invoiceUrl }
 *
 * Stripe-hosted receipt and invoice for a payment. :paymentId is a Salesforce Payment__c Id, or
 * `local:<contractId>` for a contract whose checkout payment has no Salesforce record. Each URL is null
 * when Stripe has no such document (a receipt and an invoice are separate; one can exist without the other).
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { getOwnedPayment, stripeDocuments, type PaymentDocuments } from '$lib/server/payments/balance';

const cache = new Map<string, { at: number; docs: PaymentDocuments }>();
const TTL = 5 * 60_000;

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Sign in required.');
	const [u] = await sql<{ account_id: string | null }[]>`SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1`;
	if (!u?.account_id) throw error(403, 'No account.');

	let pi: string | null = null;
	if (params.paymentId.startsWith('local:')) {
		const [c] = await sql<{ pi: string }[]>`
			SELECT stripe_payment_intent_id AS pi FROM service_contracts WHERE id::text = ${params.paymentId.slice(6)} AND account_id = ${u.account_id}`;
		pi = c?.pi ?? null;
	} else {
		const owned = await getOwnedPayment(u.account_id, params.paymentId);
		if (!owned) throw error(404, 'Payment not found.');
		pi = owned.payment.Stripe_Payment_Intent_Id__c;
		// Contract-level checkout payments carry the contract's own charge.
		if (!pi && owned.payment.Status__c === 'Paid') {
			const [c] = await sql<{ pi: string }[]>`SELECT stripe_payment_intent_id AS pi FROM service_contracts WHERE id = ${owned.contractId}`;
			pi = c?.pi ?? null;
		}
	}
	const hit = pi ? cache.get(pi) : null;
	if (hit && Date.now() - hit.at < TTL) return json(hit.docs);
	const docs = await stripeDocuments(pi);
	if (pi && (docs.receiptUrl || docs.invoiceUrl)) cache.set(pi, { at: Date.now(), docs });
	return json(docs, { headers: { 'cache-control': 'private, no-store' } });
};
