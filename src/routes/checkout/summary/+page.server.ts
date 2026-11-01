/**
 * Look up every selected PricebookEntry server-side so the summary cannot be
 * tampered with via query string. Also resolve + verify ownership of the
 * `store=<localStoreId>` param passed in from /stores/<id>/services — the
 * downstream service contract attaches to it.
 *
 * URL shape: /checkout/summary?id=<peId>&id=<peId>&store=<localStoreId>
 */
import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getCatalogProduct, dueNow, balanceLater, type CatalogProduct } from '$lib/server/salesforce';
import { sql } from '$lib/server/db';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const kind: 'service' | 'subscription' =
		url.searchParams.get('kind') === 'subscription' ? 'subscription' : 'service';

	// NOT deduped: the same service can be purchased more than once in one
	// order (e.g. the same service line for several locations) — each
	// repeated id becomes its own line item and its own Case downstream.
	const ids = url.searchParams.getAll('id').map((s) => s.trim()).filter(Boolean);
	if (ids.length === 0) throw redirect(303, '/stores');
	if (ids.length > 20) throw error(400, 'Too many items selected (max 20).');
	if (kind === 'subscription' && ids.length > 1) {
		throw error(400, 'Only one subscription plan can be selected at a time.');
	}

	const products = await Promise.all(ids.map((id) => getCatalogProduct(id, kind)));
	const items: CatalogProduct[] = [];
	const missing: string[] = [];
	products.forEach((p, i) => {
		if (p) items.push(p);
		else missing.push(ids[i]);
	});

	const currency = items[0]?.currency ?? 'USD';
	const total = items.reduce((s, p) => s + p.unitPrice, 0);

	// Group by pricebookEntryId for display only — `items` stays flat (one
	// entry per unit) so checkout still creates one line item + Case per unit.
	const groupedMap = new Map<string, CatalogProduct & { quantity: number; lineTotal: number }>();
	for (const p of items) {
		const existing = groupedMap.get(p.pricebookEntryId);
		if (existing) {
			existing.quantity += 1;
			existing.lineTotal += p.unitPrice;
		} else {
			groupedMap.set(p.pricebookEntryId, { ...p, quantity: 1, lineTotal: p.unitPrice });
		}
	}
	const groupedItems = [...groupedMap.values()];

	// Resolve the store the catalog was opened from. Verify ownership.
	const storeIdParam = url.searchParams.get('store')?.trim();
	let selectedStore: { id: string; name: string; sfdcStoreId: string | null } | null = null;
	if (storeIdParam) {
		const [row] = await sql<
			{ id: string; name: string; sfdc_store_id: string | null }[]
		>`
			SELECT s.id, s.name, s.sfdc_store_id
			FROM stores s JOIN users u ON u.id = ${locals.user.id}
			WHERE s.id = ${storeIdParam} AND s.account_id = u.account_id
			LIMIT 1
		`;
		if (row) {
			selectedStore = { id: row.id, name: row.name, sfdcStoreId: row.sfdc_store_id };
		}
	}

	// Deposit products are paid in parts: a first payment now (Full: price × qty, Deposit: deposit × qty)
	// and the remaining balance as separate payment records afterwards.
	const dueFirst = Math.round(items.reduce((s, p) => s + dueNow(p), 0) * 100) / 100;
	const split = items.some((p) => p.paymentType === 'Deposit');

	return { items: groupedItems, missing, total, currency, selectedStore, kind, split, dueFirst, dueLater: Math.round(items.reduce((s, p) => s + balanceLater(p), 0) * 100) / 100 };
};
