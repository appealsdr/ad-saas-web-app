import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { logError, describeError } from '$lib/server/error_log';
import { sql } from '$lib/server/db';
import { stripeFee } from '$lib/server/payments/fees';
import { getOwnedPayment, STATUS_REQUEST } from '$lib/server/payments/balance';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const [u] = await sql<{ account_id: string | null }[]>`SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1`;
	if (!u?.account_id) throw error(403, 'No account.');
	let owned;
	try {
		owned = await getOwnedPayment(u.account_id, params.paymentId);
	} catch (e) {
		const d = describeError(e);
		await logError({ source: 'payments.pay_page', operation: 'get_owned_payment', userId: locals.user.id, accountId: u.account_id, errorMessage: d.errorMessage, stack: d.stack, context: { paymentId: params.paymentId } });
		throw error(502, 'Could not load this payment right now. Please try again.');
	}
	if (!owned) throw error(404, 'Payment not found.');
	const p = owned.payment;
	return {
		contractId: owned.contractId,
		paymentId: p.Id,
		name: p.Name,
		description: p.Description__c ?? 'Service balance',
		amount: p.Amount__c ?? 0,
		fee: stripeFee(p.Amount__c ?? 0),
		currency: owned.currency.toUpperCase(),
		status: p.Status__c ?? 'Pending',
		// Informational only — /api/payments/:id/intent re-checks Salesforce before any charge.
		payable: p.Status__c === STATUS_REQUEST,
		paid: p.Status__c === 'Paid'
	};
};
