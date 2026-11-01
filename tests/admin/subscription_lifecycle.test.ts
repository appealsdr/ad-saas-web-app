import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ sfUpdate: vi.fn(), cancel: vi.fn(), setAccount: vi.fn(), setStore: vi.fn() }));
vi.mock('$lib/server/salesforce/client', () => ({ sobjectUpdate: m.sfUpdate, SalesforceApiError: class extends Error {} }));
vi.mock('$lib/server/salesforce', () => ({
	cancelServiceContract: m.cancel,
	setAccountActiveServiceContract: m.setAccount,
	setStoreActiveServiceContract: m.setStore
}));

import { sql } from '$lib/server/db';
import { hasDb, makeAccount, uniq } from '../setup/db';
import { handleSubscriptionEnded, handleSubscriptionUpdated, isCancelling, subscriptionEnd } from '$lib/server/subscription_lifecycle';
import { getAccountSubscription } from '$lib/server/subscription';

const unix = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

describe('subscription end date from Stripe', () => {
	it('prefers cancel_at, then the item period end, then the legacy field', () => {
		expect(subscriptionEnd({ id: 's', cancel_at_period_end: true, cancel_at: unix('2027-03-01T00:00:00Z'), items: { data: [{ current_period_end: unix('2027-02-01T00:00:00Z') }] } })?.toISOString().slice(0, 10)).toBe('2027-03-01');
		expect(subscriptionEnd({ id: 's', cancel_at_period_end: true, cancel_at: null, items: { data: [{ current_period_end: unix('2027-02-01T00:00:00Z') }] } })?.toISOString().slice(0, 10)).toBe('2027-02-01');
		expect(subscriptionEnd({ id: 's', cancel_at_period_end: false, cancel_at: null, current_period_end: unix('2027-01-05T00:00:00Z') })?.toISOString().slice(0, 10)).toBe('2027-01-05');
		expect(subscriptionEnd({ id: 's', cancel_at_period_end: false, cancel_at: null })).toBeNull();
	});
	it('detects a cancellation request either way Stripe expresses it', () => {
		expect(isCancelling({ id: 's', cancel_at_period_end: true, cancel_at: null })).toBe(true);
		expect(isCancelling({ id: 's', cancel_at_period_end: false, cancel_at: unix('2027-01-01T00:00:00Z') })).toBe(true);
		expect(isCancelling({ id: 's', cancel_at_period_end: false, cancel_at: null })).toBe(false);
	});
});

const d = describe.skipIf(!hasDb);

async function subscription() {
	const A = await makeAccount({ sfdc: '001' + uniq().padEnd(12, 'X') });
	const subId = 'sub_' + uniq();
	const sf = '810' + uniq().padEnd(12, 'Y');
	const [c] = await sql<{ id: string }[]>`
		INSERT INTO service_contracts (account_id, stripe_payment_intent_id, stripe_subscription_id, kind, amount_cents, currency, paid_at, start_date, end_date, status, sfdc_service_contract_id)
		VALUES (${A.id}, ${'pi_' + uniq()}, ${subId}, 'subscription', 10000, 'usd', now(), '2026-01-01', '2027-01-01', 'active', ${sf}) RETURNING id`;
	await sql`INSERT INTO service_contract_line_items (service_contract_id, product_name, unit_price, quantity, currency) VALUES (${c.id}, 'Monitoring', 100, 1, 'usd')`;
	await sql`UPDATE accounts SET active_subscription_contract_id = ${c.id} WHERE id = ${A.id}`;
	await sql`INSERT INTO stores (account_id, name, sfdc_store_id) VALUES (${A.id}, 'S1', ${'a0Q' + uniq().padEnd(12, 'Z')})`;
	return { A, subId, sf, contractId: c.id };
}
const row = async (id: string) => (await sql<{ status: string; end_date: Date; cancel_requested_at: Date | null }[]>`SELECT status, end_date, cancel_requested_at FROM service_contracts WHERE id = ${id}`)[0];

d('subscription cancellation lifecycle', () => {
	beforeEach(() => { Object.values(m).forEach((f) => f.mockReset()); m.sfUpdate.mockResolvedValue({}); });

	it('cancel requested: stays active, end date = Stripe date, pushed to Salesforce, shown as cancelling', async () => {
		const t = await subscription();
		const sub = { id: t.subId, cancel_at_period_end: true, cancel_at: unix('2026-11-20T00:00:00Z') };
		expect(await handleSubscriptionUpdated(sub)).toBe('cancelling');
		const c = await row(t.contractId);
		expect(c.status).toBe('active');
		expect(c.end_date.toISOString().slice(0, 10)).toBe('2026-11-20');
		expect(c.cancel_requested_at).not.toBeNull();
		expect(m.sfUpdate).toHaveBeenCalledWith('ServiceContract', t.sf, { EndDate: '2026-11-20' });
		// the plan is still the account's active subscription, now flagged as ending
		const active = await getAccountSubscription(t.A.id);
		expect(active).toMatchObject({ cancelling: true });
		expect(active?.endDate.toISOString().slice(0, 10)).toBe('2026-11-20');
		expect(m.cancel).not.toHaveBeenCalled();
		// redelivered event changes nothing
		m.sfUpdate.mockClear();
		expect(await handleSubscriptionUpdated(sub)).toBe('unchanged');
		expect(m.sfUpdate).not.toHaveBeenCalled();
	});

	it('resumed: cancellation request cleared and end date restored to the current period end', async () => {
		const t = await subscription();
		await handleSubscriptionUpdated({ id: t.subId, cancel_at_period_end: true, cancel_at: unix('2026-11-20T00:00:00Z') });
		m.sfUpdate.mockClear();
		const out = await handleSubscriptionUpdated({ id: t.subId, cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: unix('2027-01-01T00:00:00Z') }] } });
		expect(out).toBe('resumed');
		const c = await row(t.contractId);
		expect(c.cancel_requested_at).toBeNull();
		expect(c.end_date.toISOString().slice(0, 10)).toBe('2027-01-01');
		expect(m.sfUpdate).toHaveBeenCalledWith('ServiceContract', t.sf, { EndDate: '2027-01-01' });
	});

	it('an ordinary renewal update (no cancellation) changes nothing', async () => {
		const t = await subscription();
		expect(await handleSubscriptionUpdated({ id: t.subId, cancel_at_period_end: false, cancel_at: null, items: { data: [{ current_period_end: unix('2027-06-01T00:00:00Z') }] } })).toBe('unchanged');
		expect((await row(t.contractId)).end_date.toISOString().slice(0, 10)).toBe('2027-01-01');
		expect(m.sfUpdate).not.toHaveBeenCalled();
	});

	it('subscription ended: contract cancelled, account has no active subscription, Salesforce cancelled and pointers cleared', async () => {
		const t = await subscription();
		await handleSubscriptionUpdated({ id: t.subId, cancel_at_period_end: true, cancel_at: unix('2026-11-20T00:00:00Z') });
		await handleSubscriptionEnded(t.subId);
		const c = await row(t.contractId);
		expect(c.status).toBe('cancelled');
		expect(await getAccountSubscription(t.A.id)).toBeNull();
		expect(m.cancel).toHaveBeenCalledWith(t.sf, { accountId: t.A.id });
		expect(m.setAccount).toHaveBeenCalledWith(expect.any(String), null, { accountId: t.A.id });
		expect(m.setStore).toHaveBeenCalledWith(expect.any(String), null, { accountId: t.A.id });
		// idempotent
		m.cancel.mockClear();
		await handleSubscriptionEnded(t.subId);
		expect(m.cancel).not.toHaveBeenCalled();
	});

	it('unknown subscriptions are ignored', async () => {
		expect(await handleSubscriptionUpdated({ id: 'sub_nope', cancel_at_period_end: true, cancel_at: unix('2026-11-20T00:00:00Z') })).toBe('unchanged');
		await handleSubscriptionEnded('sub_nope');
		expect(m.cancel).not.toHaveBeenCalled();
	});
});
