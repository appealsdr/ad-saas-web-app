/**
 * Re-validates the selection (same logic as /checkout/summary) and exposes
 * the line items + total to the page so the user sees the same numbers Stripe
 * is about to charge.
 *
 * The actual PaymentIntent is created from the browser via
 * POST /api/checkout/payment_intent — that endpoint also re-validates server-
 * side, so a tampered query string can't change the amount.
 */
import { redirect, error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getCatalogProduct, parseRecurringOptions, dueNow, balanceLater } from '$lib/server/salesforce';

export const load: PageServerLoad = async ({ url, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const kindParam = url.searchParams.get('kind');
	const kind: 'service' | 'subscription' | 'recurring' =
		kindParam === 'subscription' ? 'subscription' : kindParam === 'recurring' ? 'recurring' : 'service';
	const recurring = kind === 'recurring' ? parseRecurringOptions(url.searchParams.get('term'), url.searchParams.get('pay')) : null;
	if (kind === 'recurring' && !recurring) throw error(400, 'Choose a valid term and payment option.');

	// NOT deduped — the same service can be bought more than once in one order.
	const ids = url.searchParams.getAll('id').map((s) => s.trim()).filter(Boolean);
	if (ids.length === 0) throw redirect(303, '/stores');
	if (ids.length > 20) throw error(400, 'Too many items selected (max 20).');
	if (kind === 'subscription' && ids.length > 1) {
		throw error(400, 'Only one subscription plan can be selected at a time.');
	}

	const products = await Promise.all(ids.map((id) => getCatalogProduct(id, kind, recurring)));
	const items = products.filter((p): p is NonNullable<typeof p> => p !== null);
	if (items.length === 0) throw redirect(303, '/stores');

	const currency = items[0].currency;
	const orderTotal = items.reduce((s, p) => s + p.unitPrice, 0);
	// What is charged now (deposit products at their deposit); the rest is billed on case completion.
	const total = Math.round(items.reduce((s, p) => s + dueNow(p), 0) * 100) / 100;
	const balanceTotal = Math.round(items.reduce((s, p) => s + balanceLater(p), 0) * 100) / 100;

	// Grouped for the recap list only — `items`/`pricebookEntryIds` below stay
	// flat (one entry per unit) so the PaymentIntent metadata still carries
	// one id per unit purchased.
	const groupedMap = new Map<string, (typeof items)[number] & { quantity: number; lineTotal: number; dueNow: number }>();
	for (const p of items) {
		const existing = groupedMap.get(p.pricebookEntryId);
		if (existing) {
			existing.quantity += 1;
			existing.lineTotal += p.unitPrice;
			existing.dueNow += dueNow(p);
		} else {
			groupedMap.set(p.pricebookEntryId, { ...p, quantity: 1, lineTotal: p.unitPrice, dueNow: dueNow(p) });
		}
	}
	const groupedItems = [...groupedMap.values()];

	const storeId = url.searchParams.get('store')?.trim() || null;

	return {
		items: groupedItems,
		total,
		orderTotal,
		balanceTotal,
		currency,
		pricebookEntryIds: items.map((p) => p.pricebookEntryId),
		userEmail: locals.user.email,
		storeId,
		kind,
		recurring
	};
};
