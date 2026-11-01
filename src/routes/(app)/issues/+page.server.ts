/**
 * Account-wide Issues page — Cases across ALL stores for the signed-in user's
 * account.
 *
 * Flow:
 *  1. Find the user's account.
 *  2. Read every store the account owns (with sfdc_store_id).
 *  3. One SOQL: `WHERE Store__c IN (…)` for all SF-linked stores at once.
 *  4. Join each case back to its store so the UI can show the store name +
 *     deep-link to the case detail under that store's URL.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { listCasesForStores, type CaseSummaryWithStore } from '$lib/server/salesforce';

interface StoreRow {
	id: string;
	name: string;
	sfdc_store_id: string | null;
}

export interface IssueRow extends CaseSummaryWithStore {
	localStoreId: string | null;
	storeName: string | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const [user] = await sql<{ account_id: string | null }[]>`
		SELECT account_id FROM users WHERE id = ${locals.user.id} LIMIT 1
	`;
	if (!user?.account_id) {
		return { issues: [] as IssueRow[], storesError: null, storesTotal: 0 };
	}

	const stores = await sql<StoreRow[]>`
		SELECT id, name, sfdc_store_id
		FROM stores WHERE account_id = ${user.account_id}
	`;
	const linkedStores = stores.filter((s) => s.sfdc_store_id);
	const sfdcIds = linkedStores.map((s) => s.sfdc_store_id as string);

	// Map sfdc_store_id → { localId, name } for joining cases back.
	const storeBySfdcId = new Map<string, { localId: string; name: string }>();
	for (const s of linkedStores) {
		storeBySfdcId.set(s.sfdc_store_id as string, { localId: s.id, name: s.name });
	}

	const result = await listCasesForStores(sfdcIds, {
		userId: locals.user.id,
		accountId: user.account_id
	});

	if (!result.ok) {
		return {
			issues: [] as IssueRow[],
			storesError: result.error,
			storesTotal: stores.length
		};
	}

	const issues: IssueRow[] = result.cases.map((c) => {
		const local = c.sfdcStoreId ? storeBySfdcId.get(c.sfdcStoreId) ?? null : null;
		return {
			...c,
			localStoreId: local?.localId ?? null,
			storeName: local?.name ?? null
		};
	});

	return { issues, storesError: null, storesTotal: stores.length };
};
