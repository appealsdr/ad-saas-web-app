/**
 * Store-scoped "Plan & Services" — merged services catalog + active plan
 * summary (previously two separate tabs).
 *
 * Loads the SERVICE pricebook from Salesforce (cached 5 min in-process) and
 * verifies the user owns the store in the URL. The selected items get
 * forwarded to /checkout/summary with `store=<localStoreId>` so the
 * downstream flow knows which service contract attaches to. The active
 * subscription (if any) is loaded here too so the top-of-page plan
 * banner / "subscribe" block can render without a second tab.
 */
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { listServices, listRecurring, RECURRING_TERMS } from '$lib/server/salesforce';

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const [store] = await sql<
		{ id: string; name: string; sfdc_store_id: string | null }[]
	>`
		SELECT s.id, s.name, s.sfdc_store_id
		FROM stores s JOIN users u ON u.id = ${locals.user.id}
		WHERE s.id = ${params.id} AND s.account_id = u.account_id
		LIMIT 1
	`;
	if (!store) throw error(404, 'Store not found.');

	const [categories, recurringCategories, [activePlan]] = await Promise.all([
		listServices(),
		listRecurring(),
		sql<{ name: string | null; price: number | null; end_date: Date; cancelling: boolean }[]>`
			SELECT scli.product_name AS name, scli.unit_price AS price, sc.end_date, (sc.cancel_requested_at IS NOT NULL) AS cancelling
			FROM accounts a
			JOIN service_contracts sc ON sc.id = a.active_subscription_contract_id
			LEFT JOIN service_contract_line_items scli ON scli.service_contract_id = sc.id
			WHERE a.id = (SELECT account_id FROM stores WHERE id = ${store.id})
			  AND sc.kind = 'subscription' AND sc.status = 'active'
			ORDER BY scli.created_at ASC
			LIMIT 1
		`
	]);

	return {
		categories,
		// Empty when SFDC_PRICE_RECURRING isn't set / the price book has no entries → tab hidden.
		recurringCategories,
		recurringTerms: [...RECURRING_TERMS],
		store: {
			id: store.id,
			name: store.name,
			sfdcStoreId: store.sfdc_store_id
		},
		activePlan: activePlan
			? {
					name: activePlan.name ?? 'Active plan',
					price: activePlan.price,
					endDate: activePlan.end_date.toISOString().slice(0, 10),
					cancelling: activePlan.cancelling
				}
			: null
	};
};
