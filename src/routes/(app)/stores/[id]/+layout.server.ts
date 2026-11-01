/**
 * Store tab-bar shell.
 *
 * Verifies store ownership once for every child route under
 * stores/[id]/... and exposes whether the account's Salesforce Account
 * record has AI Chat / AI Assistant enabled — the AI Chat tab and its
 * "Assistance" sub-tab only render when the corresponding flag is true.
 */
import { redirect, error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { fetchSalesforceAccount } from '$lib/server/salesforce';

interface StoreTabRow {
	id: string;
	name: string;
	active_subscription: boolean;
	sfdc_account_id: string | null;
}

export const load: LayoutServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const [row] = await sql<StoreTabRow[]>`
		SELECT s.id, s.name,
		       (sc.kind = 'subscription' AND sc.status = 'active') AS active_subscription,
		       a.sfdc_account_id
		FROM stores s
		JOIN users u ON u.id = ${locals.user.id}
		JOIN accounts a ON a.id = u.account_id
		LEFT JOIN accounts acct ON acct.id = s.account_id
		LEFT JOIN service_contracts asub ON asub.id = acct.active_subscription_contract_id AND asub.status = 'active'
		LEFT JOIN service_contracts sc ON sc.id = COALESCE(asub.id, s.active_service_contract_id)
		WHERE s.id = ${params.id} AND s.account_id = u.account_id
		LIMIT 1
	`;
	if (!row) throw error(404, 'Store not found.');

	let aiChatEnabled = false;
	let aiAssistantEnabled = false;
	if (row.sfdc_account_id) {
		const result = await fetchSalesforceAccount(row.sfdc_account_id, {
			userId: locals.user.id
		});
		if (result.ok) {
			aiChatEnabled = result.record.Enable_AI_Chat__c === true;
			aiAssistantEnabled = result.record.Enable_AI_Assistant__c === true;
		}
	}

	return {
		storeTab: {
			id: row.id,
			name: row.name,
			hasActiveSubscription: row.active_subscription,
			aiChatEnabled,
			aiAssistantEnabled
		}
	};
};
