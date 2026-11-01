import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	present: new Set<string>(),
	createStore: vi.fn(),
	updateStore: vi.fn(),
	update: vi.fn()
}));
vi.mock('$lib/server/salesforce/client', () => ({
	// Presence lookups: `SELECT Id FROM X WHERE Id IN ('a','b')` → the ids we marked present.
	sfdcQuery: vi.fn(async (soql: string) => ({
		records: [...soql.matchAll(/'([A-Za-z0-9]+)'/g)].map((x) => x[1]).filter((id) => m.present.has(id)).map((Id) => ({ Id })),
		done: true, totalSize: 0
	})),
	sobjectUpdate: m.update,
	SalesforceApiError: class extends Error {}
}));
vi.mock('$lib/server/salesforce/stores', () => ({ createSalesforceStore: m.createStore, updateSalesforceStore: m.updateStore }));

import { sql } from '$lib/server/db';
import { hasDb, makeAccount, uniq } from '../setup/db';
import { resyncRecord } from '$lib/server/admin/sf_sync';

const d = describe.skipIf(!hasDb);
const ctx = { actor: { userId: null, ref: 'tester@example.test', role: 'platform_admin' } };
const sfid = (p: string) => (p + uniq() + 'ABCDEFGHIJKLMNOP').slice(0, 15);

async function fixture(linkStore: string | null) {
	const acctSf = sfid('001');
	const A = await makeAccount({ sfdc: acctSf });
	const [s] = await sql<{ id: string }[]>`INSERT INTO stores (account_id, name, sfdc_store_id) VALUES (${A.id}, 'Mode Store', ${linkStore}) RETURNING id`;
	m.present.add(acctSf);
	return { A, storeId: s.id };
}

d('Salesforce sync modes', () => {
	beforeEach(() => { m.present.clear(); m.createStore.mockReset(); m.updateStore.mockReset(); m.update.mockReset(); });

	it('create: a record that is not in Salesforce is created and linked', async () => {
		const { A, storeId } = await fixture(null);
		const created = sfid('a0Q');
		m.createStore.mockResolvedValueOnce({ ok: true, sfdcStoreId: created });
		const r = await resyncRecord(ctx, A.id, 'store', storeId, 'creation failed earlier', 'create');
		expect(r.message).toMatch(/created in Salesforce/i);
		expect(m.createStore).toHaveBeenCalledTimes(1);
		const [row] = await sql<{ sfdc_store_id: string }[]>`SELECT sfdc_store_id FROM stores WHERE id = ${storeId}`;
		expect(row.sfdc_store_id).toBe(created);
	});

	it('create: a stale link (record deleted in Salesforce) is replaced', async () => {
		const stale = sfid('a0Q');
		const { A, storeId } = await fixture(stale); // stale id is NOT marked present
		const fresh = sfid('a0Q');
		m.createStore.mockResolvedValueOnce({ ok: true, sfdcStoreId: fresh });
		const r = await resyncRecord(ctx, A.id, 'store', storeId, 'deleted by mistake', 'create');
		expect(r.message).toMatch(/recreated and relinked/i);
		const [row] = await sql<{ sfdc_store_id: string }[]>`SELECT sfdc_store_id FROM stores WHERE id = ${storeId}`;
		expect(row.sfdc_store_id).toBe(fresh);
	});

	it('create is refused when the record already exists (no duplicates)', async () => {
		const linked = sfid('a0Q');
		const { A, storeId } = await fixture(linked);
		m.present.add(linked);
		await expect(resyncRecord(ctx, A.id, 'store', storeId, 'try to duplicate', 'create')).rejects.toThrow(/already exists in Salesforce/);
		expect(m.createStore).not.toHaveBeenCalled();
	});

	it('update: pushes values to an existing record', async () => {
		const linked = sfid('a0Q');
		const { A, storeId } = await fixture(linked);
		m.present.add(linked);
		m.updateStore.mockResolvedValueOnce({ ok: true });
		const r = await resyncRecord(ctx, A.id, 'store', storeId, 'push the latest values', 'update');
		expect(r.message).toMatch(/current values pushed/i);
		expect(m.updateStore).toHaveBeenCalledWith(linked, expect.objectContaining({ name: 'Mode Store' }), expect.anything());
		expect(m.createStore).not.toHaveBeenCalled();
	});

	it('update is refused when the record is not in Salesforce', async () => {
		const { A, storeId } = await fixture(null);
		await expect(resyncRecord(ctx, A.id, 'store', storeId, 'push the latest values', 'update')).rejects.toThrow(/not in Salesforce yet/);
		expect(m.updateStore).not.toHaveBeenCalled();
	});

	it('contract update pushes status fields to the existing ServiceContract; unlinked contracts cannot be updated', async () => {
		const sfc = sfid('810');
		const A = await makeAccount({ sfdc: sfid('001') });
		const [c] = await sql<{ id: string }[]>`
			INSERT INTO service_contracts (account_id, stripe_payment_intent_id, amount_cents, currency, paid_at, start_date, end_date, payment_status, sfdc_service_contract_id)
			VALUES (${A.id}, ${'pi_' + uniq()}, 5000, 'usd', now(), '2026-01-01', '2026-04-01', 'Paid', ${sfc}) RETURNING id`;
		m.present.add(sfc);
		await resyncRecord(ctx, A.id, 'contract', c.id, 'status corrected', 'update');
		expect(m.update).toHaveBeenCalledWith('ServiceContract', sfc, expect.objectContaining({ Payment_Status__c: 'Paid', StartDate: '2026-01-01', EndDate: '2026-04-01' }));

		const [u] = await sql<{ id: string }[]>`
			INSERT INTO service_contracts (account_id, stripe_payment_intent_id, amount_cents, currency, paid_at, start_date, end_date)
			VALUES (${A.id}, ${'pi_' + uniq()}, 5000, 'usd', now(), '2026-01-01', '2026-04-01') RETURNING id`;
		await expect(resyncRecord(ctx, A.id, 'contract', u.id, 'status corrected', 'update')).rejects.toThrow(/not in Salesforce yet/);
		// create needs a recorded price book and line items — refused with a clear reason
		await expect(resyncRecord(ctx, A.id, 'contract', u.id, 'first sync failed', 'create')).rejects.toThrow(/no price book/);
	});
});
