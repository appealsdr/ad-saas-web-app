/**
 * AI Assistants overview — presentational catalog of named assistants.
 * Same ownership + active-subscription gate as the Ask page; no other data
 * yet (each card links into the real chat at /stores/[id]/chat).
 */
import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const [store] = await sql<{ id: string; name: string; has_active_subscription: boolean }[]>`
		SELECT s.id, s.name,
		       (sc.kind = 'subscription' AND sc.status = 'active') AS has_active_subscription
		FROM stores s
		JOIN users u ON u.id = ${locals.user.id}
		LEFT JOIN accounts acct ON acct.id = s.account_id
		LEFT JOIN service_contracts asub ON asub.id = acct.active_subscription_contract_id AND asub.status = 'active'
		LEFT JOIN service_contracts sc ON sc.id = COALESCE(asub.id, s.active_service_contract_id)
		WHERE s.id = ${params.id} AND s.account_id = u.account_id
		LIMIT 1
	`;
	if (!store) throw error(404, 'Store not found.');
	if (!store.has_active_subscription) {
		throw error(403, 'AI assistants are only available for stores with an active subscription.');
	}

	return { store: { id: store.id, name: store.name } };
};
