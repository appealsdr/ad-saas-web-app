/**
 * Account-wide Cases list — Cases across ALL stores for the signed-in user's
 * account. Lives in the layout so the list stays mounted while the split view
 * changes the selected child route. Deliberately reads neither `url` nor
 * `params`: switching case, view or filter must not refetch it. Refresh it with
 * invalidate('app:issues').
 *
 * Flow:
 *  1. Find the user's account.
 *  2. Read every store the account owns (with sfdc_store_id).
 *  3. One SOQL: `WHERE Store__c IN (…)` for all SF-linked stores at once.
 *  4. Join each case back to its store so the UI can show the store name +
 *     deep-link to the case detail under that store's URL.
 *
 * Never throws for a data failure: the page keeps showing what it already has.
 */
import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { listCasesForStores, getCaseSteps } from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';
import { ISSUES_DEPENDENCY } from '$lib/cases/refresh';
import { isResolved, type IssueRow } from '$lib/cases/case-list';

interface StoreRow {
	id: string;
	name: string;
	sfdc_store_id: string | null;
}

async function loadIssues(userId: string) {
	const [user] = await sql<{ account_id: string | null }[]>`
		SELECT account_id FROM users WHERE id = ${userId} LIMIT 1
	`;
	if (!user?.account_id) {
		return { issues: [] as IssueRow[], storesError: null, storesTotal: 0 };
	}

	const stores = await sql<StoreRow[]>`
		SELECT id, name, sfdc_store_id
		FROM stores WHERE account_id = ${user.account_id}
		ORDER BY id
	`;
	const linkedStores = stores.filter((s) => s.sfdc_store_id);
	const sfdcIds = linkedStores.map((s) => s.sfdc_store_id as string);

	// Map sfdc_store_id → { localId, name } for joining cases back.
	const storeBySfdcId = new Map<string, { localId: string; name: string }>();
	for (const s of linkedStores) {
		storeBySfdcId.set(s.sfdc_store_id as string, { localId: s.id, name: s.name });
	}

	const result = await listCasesForStores(sfdcIds, {
		userId,
		accountId: user.account_id
	});

	if (!result.ok) {
		return {
			issues: [] as IssueRow[],
			storesError: result.error,
			storesTotal: stores.length
		};
	}

	const stepsByCase = await getCaseSteps(
		result.cases.filter((c) => !isResolved(c.Status)).map((c) => c.Id)
	);

	const issues: IssueRow[] = result.cases.map((c) => {
		const local = c.sfdcStoreId ? storeBySfdcId.get(c.sfdcStoreId) ?? null : null;
		return {
			...c,
			localStoreId: local?.localId ?? null,
			storeName: local?.name ?? null,
			steps: stepsByCase.get(c.Id)
		};
	});

	return { issues, storesError: null, storesTotal: stores.length };
}

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	depends(ISSUES_DEPENDENCY);
	if (!locals.user) throw redirect(303, '/login');

	try {
		return await loadIssues(locals.user.id);
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'cases.list',
			operation: 'load',
			userId: locals.user.id,
			errorMessage: desc.errorMessage,
			stack: desc.stack
		});
		return {
			issues: [] as IssueRow[],
			storesError: 'Something went wrong. Please try again.' as string | null,
			storesTotal: 0
		};
	}
};
