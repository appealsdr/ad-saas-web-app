import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { getContractOverview } from '$lib/server/payments/contract_overview';
import { logError, describeError } from '$lib/server/error_log';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const [u] = await sql<{ account_id: string | null }[]>`SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1`;
	if (!u?.account_id) throw error(403, 'No account.');
	try {
		const contract = await getContractOverview(u.account_id, params.contractId);
		if (!contract) throw error(404, 'Contract not found.');
		return { contract };
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		const d = describeError(e);
		await logError({ source: 'payments.contract', operation: 'overview', userId: locals.user.id, accountId: u.account_id, errorMessage: d.errorMessage, stack: d.stack, context: { contractId: params.contractId } });
		throw error(502, 'Could not load this contract right now. Please try again.');
	}
};
