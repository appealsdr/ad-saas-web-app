import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { sql } from '$lib/server/db';
import { fetchCase, listCasesForStores } from '$lib/server/salesforce';
import { salesforceUrl } from '$lib/server/admin/links';

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'accounts.read');
	const id = event.params.caseId;
	if (!/^[a-zA-Z0-9]{15,18}$/.test(id)) throw error(404, 'Case not found.');
	const stores = await sql<{ id: string; name: string; sfdc_store_id: string | null }[]>`
		SELECT id, name, sfdc_store_id FROM stores WHERE account_id = ${accountId} AND sfdc_store_id IS NOT NULL`;
	// Tenancy: the case must belong to one of THIS account's stores.
	const list = await listCasesForStores(stores.map((s) => s.sfdc_store_id!), { accountId });
	if (!list.ok) throw error(502, `Could not verify the case in Salesforce: ${list.error}`);
	const own = list.cases.find((c) => c.Id === id || c.Id.startsWith(id));
	if (!own) throw error(404, 'Case not found on this account.');
	const full = await fetchCase(own.Id, { accountId });
	if (!full.ok) throw error(502, full.error);
	const c = full.record;
	const store = stores.find((s) => s.sfdc_store_id === own.sfdcStoreId);
	return {
		id: c.Id, number: c.CaseNumber, sfUrl: await salesforceUrl('Case', c.Id),
		store: store ? { id: store.id, name: store.name } : null,
		groups: [
			{ title: 'Case', rows: [
				{ key: 'CaseNumber', label: 'Case number', value: c.CaseNumber, own: 'sf' as const, api: 'Case.CaseNumber', mono: true },
				{ key: 'Subject', label: 'Subject', value: c.Subject ?? '—', own: 'sf' as const, api: 'Case.Subject' },
				{ key: 'Type', label: 'Service', value: c.recordTypeName ?? c.Type ?? '—', own: 'sf' as const, api: 'Case.RecordType.Name' },
				{ key: 'Status', label: 'Status', value: c.Status, own: 'sf' as const, api: 'Case.Status' },
				{ key: 'Priority', label: 'Priority', value: c.Priority ?? '—', own: 'sf' as const, api: 'Case.Priority' },
				{ key: 'Origin', label: 'Origin', value: c.Origin ?? '—', own: 'sf' as const, api: 'Case.Origin' },
				{ key: 'Description', label: 'Description', value: c.Description ?? '—', own: 'sf' as const, api: 'Case.Description' },
				{ key: 'ASIN', label: 'ASIN', value: c.asin ?? '—', own: 'sf' as const, api: 'Case.ASIN__c', mono: true },
				{ key: 'Risk', label: 'Estimated revenue at risk', value: c.estimatedRevenueAtRisk == null ? '—' : `$${c.estimatedRevenueAtRisk.toLocaleString()}`, own: 'sf' as const, api: 'Case.Estimated_Revenue_at_Risk__c' }
			] },
			{ title: 'Store', rows: [
				{ key: 'store', label: 'Store', value: store?.name ?? '—', own: 'sys' as const, note: 'from the app' }
			] },
			{ title: 'IDs & system', rows: [
				{ key: 'Id', label: 'Salesforce case', value: c.Id, own: 'local' as const, mono: true },
				{ key: 'CreatedDate', label: 'Opened', value: c.CreatedDate.replace('T', ' ').slice(0, 19) + ' UTC', own: 'sf' as const, api: 'Case.CreatedDate' },
				{ key: 'LastModifiedDate', label: 'Last modified', value: c.LastModifiedDate.replace('T', ' ').slice(0, 19) + ' UTC', own: 'sf' as const, api: 'Case.LastModifiedDate' }
			] }
		]
	};
};
