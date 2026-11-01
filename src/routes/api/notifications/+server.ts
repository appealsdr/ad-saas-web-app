/**
 * Notifications for the topbar bell:
 *   - unread Case_Message__c rows (Message_Read__c empty), excluding the
 *     signed-in user's own messages
 *   - "activities required by customer" — pending Case_File__c
 *     (required-file) rows — across every case/store in the account.
 */
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import {
	listRequiredFilesForStores,
	listRequiredFilesForCases,
	listCasesForStores,
	listRecentMessagesForCases
} from '$lib/server/salesforce';

const NOTIFICATION_LIMIT = 4;
const CASE_SCAN_LIMIT = 200;
const MESSAGE_SCAN_LIMIT = 50;

interface StoreRow {
	id: string;
	name: string;
	sfdc_store_id: string | null;
}

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) return json({ items: [], total: 0 });

	const [user] = await sql<{ account_id: string | null; sfdc_contact_id: string | null }[]>`
		SELECT account_id, sfdc_contact_id FROM users WHERE id = ${locals.user.id} LIMIT 1
	`;
	if (!user?.account_id) return json({ items: [], total: 0 });

	const stores = await sql<StoreRow[]>`
		SELECT id, name, sfdc_store_id FROM stores WHERE account_id = ${user.account_id}
	`;
	const storeBySfdcId = new Map(
		stores.filter((s) => s.sfdc_store_id).map((s) => [s.sfdc_store_id as string, s])
	);
	const sfdcStoreIds = [...storeBySfdcId.keys()];

	const ctx = { userId: locals.user.id, accountId: user.account_id };
	const casesResult = sfdcStoreIds.length
		? await listCasesForStores(sfdcStoreIds, ctx)
		: { ok: true as const, cases: [] };
	const cases = casesResult.ok ? casesResult.cases : [];
	const caseNumberById = new Map(cases.map((c) => [c.Id, c.CaseNumber]));
	const caseStoreById = new Map(
		cases.map((c) => [c.Id, c.sfdcStoreId ? (storeBySfdcId.get(c.sfdcStoreId) ?? null) : null])
	);
	const caseIds = cases.map((c) => c.Id);

	const [storeFilesResult, caseFilesResult, messagesResult] = await Promise.all([
		sfdcStoreIds.length
			? listRequiredFilesForStores(sfdcStoreIds)
			: Promise.resolve({ ok: true as const, files: [] }),
		caseIds.length
			? listRequiredFilesForCases(caseIds.slice(0, CASE_SCAN_LIMIT))
			: Promise.resolve({ ok: true as const, files: [] }),
		caseIds.length
			? listRecentMessagesForCases(caseIds.slice(0, CASE_SCAN_LIMIT), MESSAGE_SCAN_LIMIT, ctx)
			: Promise.resolve({ ok: true as const, messages: [] })
	]);

	type Item = { id: string; title: string; subtitle: string; href: string; createdAt: string | null };
	const items: Item[] = [];

	if (storeFilesResult.ok) {
		for (const f of storeFilesResult.files) {
			if (f.uploaded) continue;
			const store = storeBySfdcId.get(f.parentId) ?? null;
			items.push({
				id: f.id,
				title: `Action required: ${f.name}`,
				subtitle: store ? `Store: ${store.name}` : 'Store',
				href: store ? `/stores/${store.id}` : '/stores',
				createdAt: f.createdAt ?? null
			});
		}
	}
	if (caseFilesResult.ok) {
		for (const f of caseFilesResult.files) {
			if (f.uploaded) continue;
			const store = caseStoreById.get(f.parentId) ?? null;
			const caseNumber = caseNumberById.get(f.parentId) ?? null;
			items.push({
				id: f.id,
				title: `Action required: ${f.name}`,
				subtitle: caseNumber ? `Case ${caseNumber}${store ? ` · ${store.name}` : ''}` : 'Case',
				href: store ? `/stores/${store.id}/issues/${f.parentId}` : '/issues',
				createdAt: f.createdAt ?? null
			});
		}
	}
	if (messagesResult.ok) {
		for (const m of messagesResult.messages) {
			if (m.messageRead) continue; // already read
			if (user.sfdc_contact_id && m.senderContactId === user.sfdc_contact_id) continue; // own message
			const store = caseStoreById.get(m.caseId) ?? null;
			const author = m.displayName ?? m.senderContactName ?? m.createdByName ?? 'Someone';
			items.push({
				id: m.Id,
				title: `New message from ${author}`,
				subtitle: `Case ${m.caseNumber}${store ? ` · ${store.name}` : ''}`,
				href: store ? `/stores/${store.id}/issues/${m.caseId}` : '/issues',
				createdAt: m.createdAt
			});
		}
	}

	items.sort((a, b) => {
		const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
		const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
		return tb - ta;
	});

	return json({
		items: items.slice(0, NOTIFICATION_LIMIT).map(({ createdAt: _createdAt, ...rest }) => rest),
		total: items.length
	});
};
