import type { PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { sql } from '$lib/server/db';
import { listCasesForStores } from '$lib/server/salesforce';
import { salesforceUrl } from '$lib/server/admin/links';

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'accounts.read');
	const stores = await sql<{ id: string; name: string; sfdc_store_id: string | null }[]>`
		SELECT id, name, sfdc_store_id FROM stores WHERE account_id = ${accountId} ORDER BY name`;
	const linked = stores.filter((s) => s.sfdc_store_id);
	const res = linked.length ? await listCasesForStores(linked.map((s) => s.sfdc_store_id!), { accountId }) : ({ ok: true, cases: [] } as const);
	const byStore = new Map(stores.map((s) => [s.sfdc_store_id, s]));
	const cases = res.ok
		? await Promise.all(res.cases.map(async (c) => ({
			id: c.Id, number: c.CaseNumber, service: c.recordTypeName ?? c.Subject ?? '—', subject: c.Subject, status: c.Status, priority: c.Priority,
			opened: c.CreatedDate, modified: c.LastModifiedDate,
			storeId: byStore.get(c.sfdcStoreId)?.id ?? null, storeName: byStore.get(c.sfdcStoreId)?.name ?? '—',
			sfUrl: await salesforceUrl('Case', c.Id)
		})))
		: [];
	return { cases, error: res.ok ? null : res.error, unlinkedStores: stores.length - linked.length };
};
