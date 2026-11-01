import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { getOwnedPayment, STATUS_REQUEST } from '$lib/server/payments/balance';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const [u] = await sql<{ account_id: string | null }[]>`SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1`;
	if (!u?.account_id) throw error(403, 'No account.');
	const owned = await getOwnedPayment(u.account_id, params.paymentId);
	if (!owned) throw error(404, 'Payment not found.');
	const p = owned.payment;
	return {
		paymentId: p.Id,
		name: p.Name,
		description: p.Description__c ?? 'Service balance',
		amount: p.Amount__c ?? 0,
		currency: owned.currency.toUpperCase(),
		status: p.Status__c ?? 'Pending',
		// Informational only — /api/payments/:id/intent re-checks Salesforce before any charge.
		payable: p.Status__c === STATUS_REQUEST,
		paid: p.Status__c === 'Paid'
	};
};
