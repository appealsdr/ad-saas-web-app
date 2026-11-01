/**
 * Assistance sub-tab — gated by Account.Enable_AI_Assistant__c (fetched in
 * the parent stores/[id]/+layout.server.ts). Ownership is already verified
 * by that layout; here we only re-check the feature flag since a direct URL
 * hit would otherwise bypass the hidden tab.
 */
import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';

export const load: PageServerLoad = async ({ params, locals, parent }) => {
	if (!locals.user) throw redirect(303, '/login');

	const { storeTab } = await parent();
	if (!storeTab.aiAssistantEnabled) {
		throw error(403, 'AI Assistance is not enabled for this account.');
	}

	const [store] = await sql<{ id: string; name: string }[]>`
		SELECT s.id, s.name
		FROM stores s
		JOIN users u ON u.id = ${locals.user.id}
		WHERE s.id = ${params.id} AND s.account_id = u.account_id
		LIMIT 1
	`;
	if (!store) throw error(404, 'Store not found.');

	return { store: { id: store.id, name: store.name } };
};
