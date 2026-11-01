import { describe, expect, it, vi } from 'vitest';

// A tiny in-memory Salesforce: enough for populateContract + the repair lookups.
const sf = vi.hoisted(() => ({
	lines: [] as { Id: string; PricebookEntryId: string; ServiceContractId: string }[],
	cases: [] as { Id: string; Contract_Line_Item__c: string | null; Contract__c: string }[],
	pays: [] as Record<string, unknown>[],
	contracts: new Set<string>(),
	autoPayments: false,
	n: 0
}));
vi.mock('$lib/server/salesforce/client', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/salesforce/client')>('$lib/server/salesforce/client');
	return {
		...actual,
		sobjectUpdate: vi.fn(async (object: string, id: string, b: Record<string, unknown>) => {
			if (object === 'Payment__c') Object.assign(sf.pays.find((p) => p.Id === id) ?? {}, b);
		}),
		sobjectDelete: vi.fn(async (object: string, id: string) => {
			if (object === 'Payment__c') sf.pays = sf.pays.filter((p) => p.Id !== id);
		}),
		sobjectCreate: vi.fn(async (object: string, b: Record<string, unknown>) => {
			const Id = `${object.slice(0, 3)}${String(++sf.n).padStart(12, '0')}`;
			if (object === 'ContractLineItem') {
				sf.lines.push({ Id, PricebookEntryId: String(b.PricebookEntryId), ServiceContractId: String(b.ServiceContractId) });
				if (sf.autoPayments) {
					// ContractLineItemPaymentService: a Pending 'Deposit' per deposit line and a 'First Payment' for the contract
					const sc = String(b.ServiceContractId);
					if (b.PricebookEntryId !== '01uFBM') sf.pays.push({ Id: `AUTO${++sf.n}`, Service_Contract__c: sc, Contract_Line_Item__c: Id, Payment_Type__c: 'Deposit', Amount__c: 150, Status__c: 'Pending' });
					if (!sf.pays.some((p) => p.Payment_Type__c === 'First Payment')) sf.pays.push({ Id: `AUTO${++sf.n}`, Service_Contract__c: sc, Payment_Type__c: 'First Payment', Amount__c: 1650, Status__c: 'Pending' });
				}
			}
			if (object === 'Case') sf.cases.push({ Id, Contract_Line_Item__c: (b.Contract_Line_Item__c as string) ?? null, Contract__c: String(b.Contract__c) });
			if (object === 'Payment__c') {
				// Salesforce rejects the whole record when Description__c exceeds its 255 characters.
				if (String(b.Description__c ?? '').length > 255) throw new Error(`Description: data value too large: ${String(b.Description__c).slice(0, 40)}… (max length=255)`);
				sf.pays.push({ Id, ...b });
			}
			return { success: true, id: Id, errors: [] };
		}),
		sfdcQuery: vi.fn(async (soql: string) => {
			const ok = (records: unknown[]) => ({ records, done: true, totalSize: records.length });
			if (soql.includes('FROM ContractLineItem')) return ok(sf.lines.map(({ Id, PricebookEntryId }) => ({ Id, PricebookEntryId })));
			if (soql.includes('FROM Case')) return ok(sf.cases);
			if (soql.includes('FROM Payment__c'))
				return ok(sf.pays.map((p) => ({ Id: p.Id, Contract_Line_Item__c: p.Contract_Line_Item__c ?? null, Payment_Type__c: p.Payment_Type__c ?? null, Status__c: p.Status__c ?? null, Stripe_Payment_Intent_Id__c: p.Stripe_Payment_Intent_Id__c ?? null, Order_Ref__c: p.Order_Ref__c ?? null })));
			const ids = [...soql.matchAll(/'([A-Za-z0-9]+)'/g)].map((x) => x[1]);
			return ok(ids.filter((i) => sf.contracts.has(i) || i.startsWith('001')).map((Id) => ({ Id })));
		})
	};
});

import { sql } from '$lib/server/db';
import { hasDb, makeAccount, uniq } from '../setup/db';
import { resyncRecord } from '$lib/server/admin/sf_sync';
import { createServiceContractWithLines } from '$lib/server/salesforce/contracts';

const d = describe.skipIf(!hasDb);
const ctx = { actor: { userId: null, ref: 'tester@example.test', role: 'platform_admin' } };

d('complete a partly-built Salesforce contract', () => {
	it('creates only the missing line items, cases and payments (each payment with its case), then is a no-op', async () => {
		const A = await makeAccount({ sfdc: '001' + uniq().padEnd(12, 'A') });
		const sfc = '810' + uniq().padEnd(12, 'B');
		sf.contracts.add(sfc);
		const [c] = await sql<{ id: string }[]>`
			INSERT INTO service_contracts (account_id, stripe_payment_intent_id, amount_cents, currency, paid_at, start_date, end_date, sfdc_service_contract_id, sfdc_pricebook2_id, payment_status)
			VALUES (${A.id}, ${'pi_' + uniq()}, 390000, 'usd', now(), '2026-10-26', '2027-01-26', ${sfc}, '01sPB000000000001', 'Paid') RETURNING id`;
		const line = (name: string, price: number, bal: number, pbe: string) => sql`
			INSERT INTO service_contract_line_items (service_contract_id, product_name, unit_price, quantity, currency, sfdc_pricebook_entry_id, balance_due)
			VALUES (${c.id}, ${name}, ${price}, 1, 'usd', ${pbe}, ${bal})`;
		await line('A-Z Claims', 450, 300, '01uAZ');
		await line('Account at Risk of Deactivation', 1500, 750, '01uRISK');
		await line('FBM Account Suspension', 3000, 0, '01uFBM');
		// Only the FBM line made it to Salesforce the first time (with its case), no payments.
		sf.lines.push({ Id: '811EXISTING00001', PricebookEntryId: '01uFBM', ServiceContractId: sfc });
		sf.cases.push({ Id: '500EXISTING00001', Contract_Line_Item__c: '811EXISTING00001', Contract__c: sfc });

		// …and Salesforce's own line-item automation left three pending records that duplicate the checkout charge
		sf.pays.push(
			{ Id: 'PN0070', Service_Contract__c: sfc, Contract_Line_Item__c: 'AZ-LINE', Payment_Type__c: 'Deposit', Amount__c: 150, Status__c: 'Pending' },
			{ Id: 'PN0071', Service_Contract__c: sfc, Payment_Type__c: 'First Payment', Amount__c: 900, Status__c: 'Pending' },
			{ Id: 'PN0072', Service_Contract__c: sfc, Contract_Line_Item__c: 'RISK-LINE', Payment_Type__c: 'Deposit', Amount__c: 750, Status__c: 'Pending' },
			// …and one a previous cancel-only clean-up left behind
			{ Id: 'PN0073X', Service_Contract__c: sfc, Contract_Line_Item__c: 'RISK-LINE-2', Payment_Type__c: 'Deposit', Amount__c: 750, Status__c: 'Cancelled' }
		);

		const r = await resyncRecord(ctx, A.id, 'contract', c.id, 'finish the failed sync', 'repair');
		expect(r.message).toMatch(/2 line items, 2 cases, 3 payments created/);
		expect(r.message).toMatch(/Removed 4 and cancelled 0 redundant pending payments/);

		expect(sf.lines).toHaveLength(3);
		expect(sf.cases).toHaveLength(3); // one per line item, each pointing at its line
		expect(new Set(sf.cases.map((x) => x.Contract_Line_Item__c)).size).toBe(3);
		// exactly the three required records remain: $3,900 + $300 + $750 = the $4,950 contract
		expect(sf.pays).toHaveLength(3);
		expect(sf.pays.map((p) => p.Payment_Type__c).sort()).toEqual(['Balance', 'Balance', 'Service Contract']);
		expect(sf.pays.reduce((n, p) => n + Number(p.Amount__c), 0)).toBe(4200 + 750);
		const first = sf.pays.find((p) => p.Status__c === 'Paid')!;
		expect(String(first.Description__c)).toMatch(/one transaction covering/);
		expect(String(first.Description__c)).toMatch(/FBM Account Suspension in full \(\$3,000\.00\)/);
		expect(String(first.Description__c)).toMatch(/A-Z Claims deposit \(\$150\.00\)/);
		expect(String(first.Description__c)).toMatch(/Account at Risk of Deactivation deposit \(\$750\.00\)/);
		expect(first).toMatchObject({ Amount__c: 3900, Service_Contract__c: sfc });
		expect(first.Case__c).toBeTruthy();
		const balances = sf.pays.filter((p) => p.Status__c === 'Not Active');
		expect(balances.map((b) => b.Amount__c).sort()).toEqual([300, 750]);
		for (const b of balances) {
			const lineId = b.Contract_Line_Item__c as string;
			expect(sf.cases.find((x) => x.Contract_Line_Item__c === lineId)?.Id).toBe(b.Case__c);
		}
		// the new Salesforce ids are remembered locally
		const local = await sql<{ sfdc_contract_line_item_id: string | null }[]>`SELECT sfdc_contract_line_item_id FROM service_contract_line_items WHERE service_contract_id = ${c.id}`;
		expect(local.every((l) => !!l.sfdc_contract_line_item_id)).toBe(true);

		// running it again changes nothing
		const again = await resyncRecord(ctx, A.id, 'contract', c.id, 'run it again to be sure', 'repair');
		expect(again.message).toMatch(/Nothing was missing/);
		expect([sf.lines.length, sf.cases.length, sf.pays.length]).toEqual([3, 3, 3]);
	});

	it('repair is only for contracts that exist in Salesforce', async () => {
		const A = await makeAccount({ sfdc: '001' + uniq().padEnd(12, 'C') });
		const [c] = await sql<{ id: string }[]>`
			INSERT INTO service_contracts (account_id, stripe_payment_intent_id, amount_cents, currency, paid_at, start_date, end_date)
			VALUES (${A.id}, ${'pi_' + uniq()}, 1000, 'usd', now(), '2026-10-26', '2027-01-26') RETURNING id`;
		await expect(resyncRecord(ctx, A.id, 'contract', c.id, 'finish the failed sync', 'repair')).rejects.toThrow(/not in Salesforce/);
		await expect(resyncRecord(ctx, A.id, 'store', c.id, 'finish the failed sync', 'repair')).rejects.toThrow();
	});
});

describe('a purchase: the sheet scenario end to end', () => {
	it('A-Z ($450, $150 deposit) + FBM ($3,000) + 2 × Account at Risk ($1,500, $750 deposit) → 4 line items, 4 cases, 4 payments, no duplicates', async () => {
		Object.assign(sf, { lines: [], cases: [], pays: [], autoPayments: true });
		const line = (pbe: string, name: string, price: number, balanceDue: number) => ({ pricebookEntryId: pbe, quantity: 1, unitPrice: price, name, balanceDue });
		const r = await createServiceContractWithLines({
			name: 'Sheet purchase', kind: 'service', sfdcAccountId: '001ACCOUNT0000001', sfdcContactId: null, sfdcStoreId: null, sfdcPricebook2Id: '01sPB000000000001',
			startDate: new Date('2026-10-26T00:00:00Z'), termMonths: 3,
			stripe: { paymentIntentId: 'pi_sheet', chargeId: null, amount: 4650, currency: 'USD', receiptEmail: null, paymentMethodId: null, paymentMethodType: null },
			lineItems: [line('01uAZ', 'A-Z Claims', 450, 300), line('01uFBM', 'FBM Account Suspension', 3000, 0), line('01uRISK', 'Account at Risk of Deactivation', 1500, 750), line('01uRISK', 'Account at Risk of Deactivation', 1500, 750)],
			localContractId: 'local-sheet', paymentStatus: 'Paid'
		});
		expect(r.ok).toBe(true);
		expect(sf.lines).toHaveLength(4);                       // one line item per unit
		expect(sf.cases).toHaveLength(4);                       // a case per line item
		// Salesforce's automation added 4 redundant pending records — all gone; only the required records remain
		expect(sf.pays.some((p) => ['Deposit', 'First Payment', 'Full'].includes(String(p.Payment_Type__c)))).toBe(false);
		expect(sf.pays).toHaveLength(4);
		const paid = sf.pays.filter((p) => p.Status__c === 'Paid');
		expect(paid).toHaveLength(1);
		expect(paid[0]).toMatchObject({ Amount__c: 4650, Payment_Type__c: 'Service Contract', Stripe_Payment_Intent_Id__c: 'pi_sheet' });
		const balances = sf.pays.filter((p) => p.Payment_Type__c === 'Balance').sort((a, b) => Number(a.Amount__c) - Number(b.Amount__c));
		expect(balances.map((b) => b.Amount__c)).toEqual([300, 750, 750]);
		expect(new Set(balances.map((b) => b.Contract_Line_Item__c)).size).toBe(3); // each tied to its own unit
		for (const b of balances) expect(b.Status__c).not.toBe('Paid');
		sf.autoPayments = false;
	});

	it('five units (A-Z × 2, FBM, Account at Risk × 2): the long description no longer blocks the checkout payment, so all duplicates are cleaned up', async () => {
		Object.assign(sf, { lines: [], cases: [], pays: [], autoPayments: true });
		const line = (pbe: string, name: string, price: number, balanceDue: number) => ({ pricebookEntryId: pbe, quantity: 1, unitPrice: price, name, balanceDue });
		const r = await createServiceContractWithLines({
			name: 'Five units', kind: 'service', sfdcAccountId: '001ACCOUNT0000001', sfdcContactId: null, sfdcStoreId: null, sfdcPricebook2Id: '01sPB000000000001',
			startDate: new Date('2026-10-26T00:00:00Z'), termMonths: 3,
			stripe: { paymentIntentId: 'pi_five', chargeId: null, amount: 4800, currency: 'USD', receiptEmail: null, paymentMethodId: null, paymentMethodType: null },
			lineItems: [
				line('01uAZ', 'A-Z Claims', 450, 300), line('01uAZ', 'A-Z Claims', 450, 300), line('01uFBM', 'FBM Account Suspension', 3000, 0),
				line('01uRISK', 'Account at Risk of Deactivation', 1500, 750), line('01uRISK', 'Account at Risk of Deactivation', 1500, 750)
			],
			localContractId: 'local-five', paymentStatus: 'Paid'
		});
		expect(r.ok).toBe(true);
		expect(sf.lines).toHaveLength(5);
		expect(sf.pays.some((p) => ['Deposit', 'First Payment', 'Full'].includes(String(p.Payment_Type__c)))).toBe(false);
		expect(sf.pays).toHaveLength(5); // 1 paid checkout payment + 4 balances (300, 300, 750, 750)
		const paid = sf.pays.filter((p) => p.Status__c === 'Paid');
		expect(paid).toHaveLength(1);
		expect(paid[0].Amount__c).toBe(4800);
		expect(String(paid[0].Description__c).length).toBeLessThanOrEqual(255);
		expect(String(paid[0].Description__c)).toMatch(/2 × A-Z Claims deposit \(\$300\.00\)/);
		expect(sf.pays.filter((p) => p.Payment_Type__c === 'Balance').map((p) => p.Amount__c).sort()).toEqual([300, 300, 750, 750]);
		sf.autoPayments = false;
	});
});
