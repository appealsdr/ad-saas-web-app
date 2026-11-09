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

import { buildRecurringLines, createServiceContractWithLines, addMonthsClamped } from '$lib/server/salesforce/contracts';

const start = new Date('2026-01-31T10:00:00Z');
const group = [{ pricebookEntryId: '01uP1', name: 'Product 1', quantity: 5, monthlyPrice: 100 }];
const base = (payOption: 'full' | 'monthly', amount: number) => ({
	name: 'R', kind: 'recurring' as const, sfdcAccountId: '001A', sfdcContactId: null, sfdcStoreId: null, sfdcPricebook2Id: '01sPB',
	startDate: start, termMonths: 6,
	stripe: { paymentIntentId: 'pi_r', chargeId: null, amount, currency: 'USD', receiptEmail: null, paymentMethodId: 'pm_1', paymentMethodType: 'card' },
	lineItems: buildRecurringLines(group, 6, start, payOption), localContractId: 'loc1'
});

describe('recurring contract structure', () => {
	beforeEach(() => { m.created.length = 0; m.n = 0; });

	it('clamps month ends', () => {
		expect(addMonthsClamped(start, 1).toISOString().slice(0, 10)).toBe('2026-02-28');
	});

	it('pay by month: 6 lines of 5 × $100, a paid first payment and 5 Not Active payments with due dates', async () => {
		await createServiceContractWithLines(base('monthly', 500));
		const lines = m.created.filter((c) => c.object === 'ContractLineItem');
		expect(lines).toHaveLength(6);
		for (const l of lines) expect(l.body).toMatchObject({ Quantity: 5, UnitPrice: 100 });
		expect(lines[0].body.Description).toMatch(/^Month 1 of 6/);
		const pays = m.created.filter((c) => c.object === 'Payment__c');
		expect(pays).toHaveLength(6);
		for (const p of pays) expect(p.body.Amount__c).toBe(500);
		const paid = pays.filter((p) => p.body.Status__c === 'Paid');
		expect(paid).toHaveLength(1);
		expect(paid[0].body).toMatchObject({ Payment_Date__c: '2026-01-31', Stripe_Payment_Intent_Id__c: 'pi_r' });
		expect(paid[0].body.Contract_Line_Item__c).toBe(lines[0].id);
		const due = pays.filter((p) => p.body.Status__c === 'Not Active');
		expect(due.map((p) => p.body.Payment_Date__c)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
		expect(due.every((p) => p.body.Contract_Line_Item__c && !p.body.Stripe_Payment_Intent_Id__c)).toBe(true);
		expect(m.created.filter((c) => c.object === 'Case')).toHaveLength(1);
	});

	it('pay in full: 6 lines, ONE $3000 payment on the contract dated the Stripe payment day', async () => {
		await createServiceContractWithLines(base('full', 3000));
		expect(m.created.filter((c) => c.object === 'ContractLineItem')).toHaveLength(6);
		const pays = m.created.filter((c) => c.object === 'Payment__c');
		expect(pays).toHaveLength(1);
		expect(pays[0].body).toMatchObject({ Amount__c: 3000, Status__c: 'Paid', Payment_Date__c: '2026-01-31', Payment_Type__c: 'Service Contract' });
		expect(pays[0].body.Contract_Line_Item__c).toBeUndefined();
	});
});
