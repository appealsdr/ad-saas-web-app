import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ created: [] as { object: string; body: Record<string, unknown>; id: string }[], n: 0 }));
vi.mock('$lib/server/salesforce/client', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/salesforce/client')>('$lib/server/salesforce/client');
	return {
		...actual,
		sobjectCreate: vi.fn(async (object: string, body: Record<string, unknown>) => {
			const id = `${object.slice(0, 3)}${String(++m.n).padStart(12, '0')}`;
			m.created.push({ object, body, id });
			return { success: true, id, errors: [] };
		}),
		sfdcQuery: vi.fn(async () => ({ records: [], done: true, totalSize: 0 }))
	};
});

import { balanceLater, dueNow } from '$lib/server/salesforce/pricebook';
import { createServiceContractWithLines } from '$lib/server/salesforce/contracts';

// The order from the bug report: A-Z Claims ($450, $150 deposit), FBM Account Suspension ($3,000, full),
// Account at Risk of Deactivation ($1,500, $750 deposit).
const P = (unitPrice: number, deposit: number | null) => ({ unitPrice, paymentType: (deposit == null ? 'Full' : 'Deposit') as 'Full' | 'Deposit', depositAmount: deposit });
const AZ = P(450, 150), FBM = P(3000, null), RISK = P(1500, 750);

describe('deposit pricing', () => {
	it('charges full price for Full products and only the deposit for Deposit products', () => {
		expect([dueNow(AZ), balanceLater(AZ)]).toEqual([150, 300]);
		expect([dueNow(FBM), balanceLater(FBM)]).toEqual([3000, 0]);
		expect([dueNow(RISK), balanceLater(RISK)]).toEqual([750, 750]);
		const items = [AZ, FBM, RISK];
		expect(items.reduce((s, p) => s + dueNow(p), 0)).toBe(3900);
		expect(items.reduce((s, p) => s + balanceLater(p), 0)).toBe(1050);
		expect(items.reduce((s, p) => s + p.unitPrice, 0)).toBe(4950);
	});
	it('never charges more than the price, and treats a missing deposit as Full', () => {
		expect(dueNow({ unitPrice: 100, paymentType: 'Deposit', depositAmount: 250 })).toBe(100);
		expect(dueNow({ unitPrice: 100, paymentType: 'Deposit', depositAmount: null })).toBe(100);
	});
});

describe('subscription line items', () => {
	beforeEach(() => { m.created.length = 0; m.n = 0; });
	const sub = (unitPrice: number, termMonths = 12) => createServiceContractWithLines({
		name: 'Plan', kind: 'subscription', sfdcAccountId: '001ACCOUNT0000001', sfdcContactId: null, sfdcStoreId: null, sfdcPricebook2Id: '01sPRICEBOOK0001',
		startDate: new Date('2026-10-26T00:00:00Z'), termMonths,
		stripe: { paymentIntentId: 'pi_sub', chargeId: null, amount: unitPrice, currency: 'USD', receiptEmail: null, paymentMethodId: null, paymentMethodType: null },
		lineItems: [{ pricebookEntryId: '01uMON', quantity: 1, unitPrice, name: 'Monitoring' }], paymentStatus: 'Subscription'
	});

	it('a one-year subscription has a line item with Quantity 12 at the monthly price', async () => {
		await sub(1200);
		const li = m.created.find((c) => c.object === 'ContractLineItem')!;
		expect(li.body).toMatchObject({ Quantity: 12, UnitPrice: 100 });
		expect(m.created.filter((c) => c.object === 'Case')).toHaveLength(0); // subscriptions open no automatic cases
	});
	it('Quantity × UnitPrice equals the yearly price (to the cent where it divides)', async () => {
		await sub(100);
		const li = m.created.find((c) => c.object === 'ContractLineItem')!;
		expect(li.body.Quantity).toBe(12);
		expect(li.body.UnitPrice).toBe(8.33);
	});
	it('service line items are unchanged', async () => {
		await createServiceContractWithLines({
			name: 'S', kind: 'service', sfdcAccountId: '001ACCOUNT0000001', sfdcContactId: null, sfdcStoreId: null, sfdcPricebook2Id: '01sPRICEBOOK0001',
			startDate: new Date('2026-10-26T00:00:00Z'), termMonths: 3,
			stripe: { paymentIntentId: 'pi_s', chargeId: null, amount: 450, currency: 'USD', receiptEmail: null, paymentMethodId: null, paymentMethodType: null },
			lineItems: [{ pricebookEntryId: '01uAZ', quantity: 1, unitPrice: 450, name: 'A-Z Claims' }]
		});
		expect(m.created.find((c) => c.object === 'ContractLineItem')!.body).toMatchObject({ Quantity: 1, UnitPrice: 450 });
	});
});

describe('contract + payments created in Salesforce', () => {
	beforeEach(() => { m.created.length = 0; m.n = 0; });

	it('creates the line items, the paid first payment, and one Not Active balance payment per deposit line', async () => {
		const r = await createServiceContractWithLines({
			name: 'Test 2026-10-26 Services', kind: 'service', sfdcAccountId: '001ACCOUNT0000001', sfdcContactId: '003CONTACT0000001', sfdcStoreId: 'a0QSTORE00000001',
			sfdcPricebook2Id: '01sPRICEBOOK0001', startDate: new Date('2026-10-26T00:00:00Z'), termMonths: 3,
			stripe: { paymentIntentId: 'pi_test_123', chargeId: 'ch_1', amount: 3900, currency: 'USD', receiptEmail: 'a@b.test', paymentMethodId: 'pm_1', paymentMethodType: 'card' },
			lineItems: [
				{ pricebookEntryId: '01uAZ', quantity: 1, unitPrice: 450, name: 'A-Z Claims', balanceDue: 300 },
				{ pricebookEntryId: '01uFBM', quantity: 1, unitPrice: 3000, name: 'FBM Account Suspension', balanceDue: 0 },
				{ pricebookEntryId: '01uRISK', quantity: 1, unitPrice: 1500, name: 'Account at Risk of Deactivation', balanceDue: 750 }
			],
			localContractId: 'local-1', paymentStatus: 'Paid'
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		const lines = m.created.filter((c) => c.object === 'ContractLineItem');
		expect(lines.map((l) => l.body.UnitPrice)).toEqual([450, 3000, 1500]); // lines keep the FULL price
		const payments = m.created.filter((c) => c.object === 'Payment__c');
		expect(payments).toHaveLength(3);

		const first = payments.find((p) => p.body.Status__c === 'Paid')!;
		expect(first.body).toMatchObject({ Amount__c: 3900, Total_Paid__c: 3900, Stripe_Payment_Intent_Id__c: 'pi_test_123', Service_Contract__c: r.sfdcServiceContractId });
		expect(first.body.Contract_Line_Item__c).toBeUndefined();

		const balances = payments.filter((p) => p.body.Status__c === 'Not Active');
		expect(balances.map((b) => b.body.Amount__c).sort()).toEqual([300, 750]);
		for (const b of balances) {
			expect(b.body.Service_Contract__c).toBe(r.sfdcServiceContractId);
			expect(b.body.Payment_Type__c).toBe('Balance');
			expect(b.body.Stripe_Payment_Intent_Id__c).toBeUndefined(); // not collected yet
			expect(b.body.Total_Paid__c).toBeUndefined();
			expect(b.body.PaidAt__c).toBeUndefined();
		}
		// each balance points at ITS line item
		const az = lines[0].id, risk = lines[2].id;
		expect(balances.find((b) => b.body.Amount__c === 300)?.body.Contract_Line_Item__c).toBe(az);
		expect(balances.find((b) => b.body.Amount__c === 750)?.body.Contract_Line_Item__c).toBe(risk);
		// every payment carries its Case (the org's "Payment After Save" flow requires it) — balances use THEIR line's case
		const cases = m.created.filter((c) => c.object === 'Case');
		expect(cases).toHaveLength(3);
		const caseOf = (lineId: string) => cases.find((c) => c.body.Contract_Line_Item__c === lineId)!.id;
		expect(balances.find((b) => b.body.Amount__c === 300)?.body.Case__c).toBe(caseOf(az));
		expect(balances.find((b) => b.body.Amount__c === 750)?.body.Case__c).toBe(caseOf(risk));
		expect(first.body.Case__c).toBe(caseOf(lines[0].id)); // contract-level payment → first line's case
		for (const p of payments) expect(p.body.Case__c).toBeTruthy();
		// the contract description separates what was paid from what is billed later
		const sc = m.created.find((c) => c.object === 'ServiceContract')!;
		expect(String(sc.body.Description)).toMatch(/Total: \$4,950\.00/);
		expect(String(sc.body.Description)).toMatch(/Paid at checkout: \$3,900\.00/);
	});

	it('without deposit services there are no balance payments', async () => {
		await createServiceContractWithLines({
			name: 'Full order', kind: 'service', sfdcAccountId: '001ACCOUNT0000001', sfdcContactId: null, sfdcStoreId: null, sfdcPricebook2Id: '01sPRICEBOOK0001',
			startDate: new Date('2026-10-26T00:00:00Z'), termMonths: 3,
			stripe: { paymentIntentId: 'pi_full', chargeId: null, amount: 3000, currency: 'USD', receiptEmail: null, paymentMethodId: null, paymentMethodType: null },
			lineItems: [{ pricebookEntryId: '01uFBM', quantity: 1, unitPrice: 3000, name: 'FBM Account Suspension', balanceDue: 0 }]
		});
		expect(m.created.filter((c) => c.object === 'Payment__c')).toHaveLength(1);
	});
});
