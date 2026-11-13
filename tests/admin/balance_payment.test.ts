import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	payment: null as Record<string, unknown> | null,
	updates: [] as { object: string; id: string; body: Record<string, unknown> }[],
	creates: [] as { object: string; body: Record<string, unknown> }[],
	stripeCreate: vi.fn(),
	failUpdate: false
}));
vi.mock('$lib/server/salesforce/client', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/salesforce/client')>('$lib/server/salesforce/client');
	return {
		...actual,
		sfdcQuery: vi.fn(async () => ({ records: m.payment ? [m.payment] : [], done: true, totalSize: 1 })),
		sobjectUpdate: vi.fn(async (object: string, id: string, body: Record<string, unknown>) => {
			if (m.failUpdate) throw new Error('boom');
			m.updates.push({ object, id, body });
			if (m.payment && m.payment.Id === id) Object.assign(m.payment, body);
		}),
		sobjectCreate: vi.fn(async (object: string, body: Record<string, unknown>) => {
			if (body.Status__c === 'Not Active') throw new Error('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Not Active');
			m.creates.push({ object, body });
			return { success: true, id: 'a1B000000000001', errors: [] };
		})
	};
});
vi.mock('$lib/server/stripe', () => ({ getStripe: () => ({ paymentIntents: { create: m.stripeCreate } }) }));

import { sql } from '$lib/server/db';
import { hasDb, makeAccount, uniq } from '../setup/db';
import { applyBalancePaid, assertCollectible, createBalanceIntent, getOwnedPayment, BalanceError } from '$lib/server/payments/balance';
import { createPayment } from '$lib/server/salesforce/payments';

const PID = 'a1B000000000PAY';
const rec = (over: Record<string, unknown> = {}) => ({
	Id: PID, Name: 'PN-0075', Amount__c: 300, Status__c: 'Request Payment', Payment_Type__c: 'Balance',
	Description__c: 'Remaining balance for A-Z Claims — collect when its case is completed', Service_Contract__c: '810CONTRACT00001',
	Contract_Line_Item__c: '811LINE000000001', Stripe_Payment_Intent_Id__c: null, ...over
});
const pi = (over: Record<string, unknown> = {}) => ({
	id: 'pi_' + uniq(), status: 'succeeded', amount: 30000, created: 1790000000, payment_method: 'pm_1',
	metadata: { kind: 'balance', base_cents: '30000', fee_cents: '927', payment_id: PID, payment_name: 'PN-0075', account_id: 'acct' }, ...over
}) as never;

describe('who can pay', () => {
	it('only a balance in Request Payment is collectible', () => {
		expect(() => assertCollectible(rec() as never)).not.toThrow();
		for (const s of ['Not Active', 'Pending', 'Paid', 'Cancelled', 'Failed', null]) {
			expect(() => assertCollectible(rec({ Status__c: s }) as never), String(s)).toThrow(BalanceError);
		}
		expect(() => assertCollectible(rec({ Amount__c: 0 }) as never)).toThrow(BalanceError);
	});
});

describe('Stripe payment uses the existing record', () => {
	beforeEach(() => { m.stripeCreate.mockReset(); m.stripeCreate.mockResolvedValue({ id: 'pi_new', client_secret: 'secret_1' }); });
	const owned = (over: Record<string, unknown> = {}) => ({ payment: rec(over) as never, contractId: 'cid-1', currency: 'usd', accountId: 'acct' });

	it("charges that record's amount and description and passes a stable reference", async () => {
		const r = await createBalanceIntent(owned(), { id: 'u1', email: 'a@b.test' }, 'cus_1');
		expect(r).toMatchObject({ clientSecret: 'secret_1', amountCents: 30000, feeCents: 927, chargeCents: 30927 }); // (30000+30)/(1-2.9%)
		const [params, opts] = m.stripeCreate.mock.calls[0];
		expect(params).toMatchObject({ amount: 30927, currency: 'usd', customer: 'cus_1' });
		expect(params.description).toContain('Remaining balance for A-Z Claims');
		expect(params.metadata).toMatchObject({ kind: 'balance', base_cents: '30000', fee_cents: '927', payment_id: PID, contract_id: 'cid-1', line_item_id: '811LINE000000001' });
		expect(opts.idempotencyKey).toBe(`balance-${PID}-30927`); // a reload returns the same PaymentIntent — no double charge
	});
	it('refuses to start a payment unless Salesforce says Request Payment', async () => {
		await expect(createBalanceIntent(owned({ Status__c: 'Not Active' }), { id: 'u1', email: 'a@b.test' })).rejects.toThrow(/not ready/);
		expect(m.stripeCreate).not.toHaveBeenCalled();
	});
});

const d = describe.skipIf(!hasDb);

d('completing the payment updates the same Payment__c, once', () => {
	beforeEach(() => { m.payment = rec(); m.updates.length = 0; m.creates.length = 0; m.failUpdate = false; });

	it('marks the existing record Paid with the Stripe details and never inserts a record', async () => {
		const p = pi();
		expect(await applyBalancePaid(p)).toBe('applied');
		expect(m.updates).toHaveLength(1);
		expect(m.updates[0]).toMatchObject({ object: 'Payment__c', id: PID, body: { Status__c: 'Paid', Total_Paid__c: 300, Stripe_Payment_Intent_Id__c: (p as { id: string }).id, Payment_Method__c: 'pm_1' } });
		expect(m.updates[0].body.PaidAt__c).toBeTruthy();
		expect(m.creates).toHaveLength(0);
	});
	it('is idempotent: the return page, the webhook and Stripe retries cannot apply it twice', async () => {
		const p = pi();
		expect(await applyBalancePaid(p)).toBe('applied');
		expect(await applyBalancePaid(p)).toBe('already');
		expect(await applyBalancePaid(p)).toBe('already');
		expect(m.updates).toHaveLength(1);
	});
	it('never re-applies to a record that is already Paid', async () => {
		m.payment = rec({ Status__c: 'Paid' });
		expect(await applyBalancePaid(pi())).toBe('already');
		expect(m.updates).toHaveLength(0);
	});
	it('ignores non-balance or unsuccessful PaymentIntents and refuses an amount mismatch', async () => {
		expect(await applyBalancePaid(pi({ metadata: { kind: 'service' } }))).toBe('ignored');
		expect(await applyBalancePaid(pi({ status: 'requires_payment_method' }))).toBe('ignored');
		const wrong = pi({ amount: 12345 });
		expect(await applyBalancePaid(wrong)).toBe('mismatch');
		expect(m.updates).toHaveLength(0);
	});
	it('a Salesforce failure releases the claim so a retry can finish the job', async () => {
		const p = pi();
		m.failUpdate = true;
		await expect(applyBalancePaid(p)).rejects.toThrow();
		m.failUpdate = false;
		expect(await applyBalancePaid(p)).toBe('applied');
		expect(m.updates).toHaveLength(1);
	});
	it('a payment is only visible to the account that owns its contract', async () => {
		const A = await makeAccount();
		const B = await makeAccount();
		await sql`INSERT INTO service_contracts (account_id, stripe_payment_intent_id, amount_cents, currency, paid_at, start_date, end_date, sfdc_service_contract_id)
		          VALUES (${A.id}, ${'pi_' + uniq()}, 100, 'usd', now(), '2026-01-01', '2026-04-01', '810CONTRACT00001')`;
		expect((await getOwnedPayment(A.id, PID))?.contractId).toBeTruthy();
		expect(await getOwnedPayment(B.id, PID)).toBeNull();
		expect(await getOwnedPayment(A.id, "x'; DROP TABLE users;--")).toBeNull();
	});
});

describe('balances start Not Active', () => {
	it("falls back to Pending when the org's Status picklist has no 'Not Active' value yet", async () => {
		m.creates.length = 0;
		const r = await createPayment({ amount: 300, currency: 'USD', status: 'Not Active', paymentType: 'Balance', sfdcServiceContractId: '810C' });
		expect(r.ok).toBe(true);
		expect(m.creates[0].body.Status__c).toBe('Pending');
	});
});
