import { beforeEach, describe, expect, it, vi } from 'vitest';

type Rec = Record<string, unknown> & { Id: string };
const m = vi.hoisted(() => ({
	contract: null as Record<string, unknown> | null,
	lines: [] as Record<string, unknown>[],
	payments: [] as Record<string, unknown>[],
	failUpdate: false,
	failContractRead: false,
	queries: [] as string[],
	event: null as unknown
}));

vi.mock('$lib/server/salesforce/client', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/salesforce/client')>('$lib/server/salesforce/client');
	return {
		...actual,
		sfdcQuery: vi.fn(async (soql: string) => {
			m.queries.push(soql);
			const id = /WHERE Id = '([^']+)'/.exec(soql)?.[1];
			let records: unknown[] = [];
			if (soql.includes('FROM ServiceContract')) {
				if (m.failContractRead) throw new Error('Salesforce down');
				records = m.contract && m.contract.Id === id ? [m.contract] : [];
			} else if (soql.includes('FROM ContractLineItem')) {
				records = soql.includes('Product2')
					? m.lines.map((l) => ({ Id: l.Id, PricebookEntry: { Product2: { Name: 'A-Z Claims' } } }))
					: m.lines;
			} else if (soql.includes('FROM Payment__c')) {
				records = id ? m.payments.filter((p) => p.Id === id) : m.payments;
			}
			return { records: structuredClone(records), done: true, totalSize: records.length };
		}),
		sobjectUpdate: vi.fn(async (_object: string, id: string, body: Record<string, unknown>) => {
			if (m.failUpdate) throw new Error('update failed');
			Object.assign(m.payments.find((p) => p.Id === id)!, body);
		})
	};
});
vi.mock('$lib/server/stripe', () => ({
	getStripe: () => ({
		webhooks: { constructEvent: () => m.event },
		paymentIntents: {
			retrieve: async () => ({
				latest_charge: { id: 'ch_1', created: 1790000000, receipt_url: 'https://stripe.test/r', payment_method_details: { type: 'card' } }
			})
		}
	})
}));
vi.mock('$env/dynamic/private', () => ({ env: { ...process.env, STRIPE_WEBHOOK_SECRET: 'whsec_test' } }));

import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeStore, uniq } from '../setup/db';
import { applyBalancePaid, ensurePaymentStored } from '$lib/server/payments/balance';
import { POST } from '../../src/routes/api/stripe/webhook/+server';

/** An 18-character Salesforce-looking id, unique per call. */
const sfId = (prefix: string) => (prefix + uniq() + '000000000000000000').slice(0, 18);

async function scenario() {
	const sfAccount = sfId('001');
	const account = await makeAccount({ sfdc: sfAccount });
	const storeId = await makeStore(account.id);
	const sfStore = sfId('a0S');
	await sql`UPDATE stores SET sfdc_store_id = ${sfStore} WHERE id = ${storeId}`;
	const contractId = sfId('810');
	const paymentId = sfId('a1B');
	m.contract = {
		Id: contractId, AccountId: sfAccount, Name: 'Contract first', ContractNumber: '00000042', Status: 'Draft',
		StartDate: '2026-11-01', EndDate: '2027-02-01', Store__c: sfStore, ContactId: null, Custom_Field__c: 'kept'
	};
	m.lines = [{ Id: sfId('811'), ServiceContractId: contractId, Quantity: 2, UnitPrice: 150, Description: 'Claims work' }];
	m.payments = [
		{ Id: paymentId, Name: 'PN-1', Amount__c: 300, Status__c: 'Request Payment', Service_Contract__c: contractId, Opportunity__c: sfId('006') },
		{ Id: sfId('a1B'), Name: 'PN-2', Amount__c: 100, Status__c: 'Not Active', Service_Contract__c: contractId }
	];
	const pi = {
		id: 'pi_' + uniq(), status: 'succeeded', amount: 30927, currency: 'usd', created: 1790000000,
		payment_method: 'pm_1', latest_charge: 'ch_1', receipt_email: 'payer@example.test',
		metadata: { kind: 'balance', base_cents: '30000', fee_cents: '927', payment_id: paymentId, payment_name: 'PN-1', account_id: account.id }
	} as never as import('stripe').Stripe.PaymentIntent;
	return { account, storeId, contractId, paymentId, pi };
}

const paymentRow = async (piId: string) =>
	(await sql<Record<string, unknown>[]>`SELECT * FROM stripe_payments WHERE stripe_payment_intent_id = ${piId}`)[0];
const copies = (contractId: string) =>
	sql<Record<string, unknown>[]>`SELECT * FROM salesforce_contracts WHERE sfdc_service_contract_id = ${contractId}`;

const d = describe.skipIf(!hasDb);

beforeEach(() => {
	m.failUpdate = false;
	m.failContractRead = false;
	m.queries.length = 0;
});

d('paying a contract that was created in Salesforce', () => {
	it('stores the payment, the contract, its lines and its payment records', async () => {
		const s = await scenario();
		expect(await applyBalancePaid(s.pi)).toBe('applied');

		const row = await paymentRow(s.pi.id);
		expect(row).toMatchObject({
			account_id: s.account.id, stripe_charge_id: 'ch_1', stripe_payment_method_type: 'card',
			stripe_receipt_email: 'payer@example.test', stripe_receipt_url: 'https://stripe.test/r',
			amount_cents: expect.anything(), currency: 'USD', sfdc_payment_id: s.paymentId, sfdc_payment_name: 'PN-1',
			sfdc_service_contract_id: s.contractId, service_contract_id: null, sf_status: 'applied'
		});
		expect([Number(row.amount_cents), Number(row.fee_cents), Number(row.charged_cents)]).toEqual([30000, 927, 30927]);

		const [contract] = await copies(s.contractId);
		expect(contract).toMatchObject({ account_id: s.account.id, store_id: s.storeId, name: 'Contract first', contract_number: '00000042' });
		expect((contract.data as Rec).Custom_Field__c).toBe('kept');
		expect(row.salesforce_contract_id).toBe(contract.id);
		expect(row.contract_stored_at).toBeTruthy();

		const lines = await sql`SELECT product_name, quantity::float AS quantity, unit_price::float AS unit_price FROM salesforce_contract_line_items WHERE salesforce_contract_id = ${contract.id as string}`;
		expect([...lines]).toEqual([{ product_name: 'A-Z Claims', quantity: 2, unit_price: 150 }]);
		const payments = await sql<{ name: string; status: string; stripe_payment_intent_id: string | null }[]>`
			SELECT name, status, stripe_payment_intent_id FROM salesforce_contract_payments WHERE salesforce_contract_id = ${contract.id as string} ORDER BY name`;
		// Copied after the Salesforce update, so the paid record shows as paid; the unpaid one is kept too.
		expect([...payments]).toEqual([
			{ name: 'PN-1', status: 'Paid', stripe_payment_intent_id: s.pi.id },
			{ name: 'PN-2', status: 'Not Active', stripe_payment_intent_id: null }
		]);
		// Nothing is added to the table of app-made purchases.
		expect(await sql`SELECT 1 FROM service_contracts WHERE account_id = ${s.account.id}`).toHaveLength(0);
	});

	it('stays at one row each when the return page, the webhook and a retry all run', async () => {
		const s = await scenario();
		await Promise.all([applyBalancePaid(s.pi), applyBalancePaid(s.pi)]);
		await ensurePaymentStored(s.pi);
		await applyBalancePaid(s.pi);
		expect(await sql`SELECT 1 FROM stripe_payments WHERE sfdc_payment_id = ${s.paymentId}`).toHaveLength(1);
		const [contract] = await copies(s.contractId);
		expect(await sql`SELECT 1 FROM salesforce_contract_line_items WHERE salesforce_contract_id = ${contract.id as string}`).toHaveLength(1);
		expect(await sql`SELECT 1 FROM salesforce_contract_payments WHERE salesforce_contract_id = ${contract.id as string}`).toHaveLength(2);
		expect((await paymentRow(s.pi.id)).sf_status).toBe('applied');
	});

	it('keeps the payment on record when Salesforce cannot be updated, then completes on retry', async () => {
		const s = await scenario();
		m.failUpdate = true;
		await expect(applyBalancePaid(s.pi)).rejects.toThrow('update failed');
		expect(await paymentRow(s.pi.id)).toMatchObject({ sf_status: 'failed', sf_error: 'update failed' });
		m.failUpdate = false;
		expect(await applyBalancePaid(s.pi)).toBe('applied');
		expect(await paymentRow(s.pi.id)).toMatchObject({ sf_status: 'applied', sf_error: null });
		expect(await copies(s.contractId)).toHaveLength(1);
	});

	it('a failed contract copy does not fail the payment and is retried by the webhook', async () => {
		const s = await scenario();
		m.failContractRead = true;
		expect(await applyBalancePaid(s.pi)).toBe('applied');
		expect((await paymentRow(s.pi.id)).contract_stored_at).toBeNull();
		await expect(ensurePaymentStored(s.pi)).rejects.toThrow('Salesforce down');
		m.failContractRead = false;
		await ensurePaymentStored(s.pi);
		expect(await copies(s.contractId)).toHaveLength(1);
		expect((await paymentRow(s.pi.id)).contract_stored_at).toBeTruthy();
	});

	it("never copies a contract that belongs to another account's Salesforce Account", async () => {
		const s = await scenario();
		m.contract!.AccountId = sfId('001');
		await applyBalancePaid(s.pi);
		expect(await copies(s.contractId)).toHaveLength(0);
		expect(await paymentRow(s.pi.id)).toMatchObject({ account_id: s.account.id, salesforce_contract_id: null, contract_stored_at: null });
	});

	it('records a payment that Salesforce already shows as paid by something else', async () => {
		const s = await scenario();
		Object.assign(m.payments[0], { Status__c: 'Paid', Stripe_Payment_Intent_Id__c: 'pi_other' });
		expect(await applyBalancePaid(s.pi)).toBe('already');
		expect((await paymentRow(s.pi.id)).sf_status).toBe('already_paid');
	});
});

d('paying a contract the app created', () => {
	it('links the payment to the existing contract instead of copying it', async () => {
		const s = await scenario();
		const [local] = await sql<{ id: string }[]>`
			INSERT INTO service_contracts (account_id, stripe_payment_intent_id, amount_cents, currency, paid_at, start_date, end_date, sfdc_service_contract_id)
			VALUES (${s.account.id}, ${'pi_' + uniq()}, 100, 'usd', now(), '2026-01-01', '2026-04-01', ${s.contractId}) RETURNING id`;
		await applyBalancePaid(s.pi);
		expect(await paymentRow(s.pi.id)).toMatchObject({ service_contract_id: local.id, salesforce_contract_id: null, sf_status: 'applied' });
		expect(await copies(s.contractId)).toHaveLength(0);
	});
});

d('Stripe webhook', () => {
	const deliver = () =>
		POST({ request: new Request('http://app.test/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 'sig' }, body: '{}' }) } as never);

	it('releases a failed event so the redelivery does the work', async () => {
		const s = await scenario();
		const eventId = 'evt_' + uniq();
		m.event = { id: eventId, type: 'payment_intent.succeeded', data: { object: s.pi } };
		m.failContractRead = true;
		await expect(deliver()).rejects.toThrow('Salesforce down');
		expect(await sql`SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id = ${eventId}`).toHaveLength(0);

		m.failContractRead = false;
		expect((await deliver()).status).toBe(200);
		expect(await copies(s.contractId)).toHaveLength(1);

		m.queries.length = 0;
		await deliver(); // a duplicate of a processed event does nothing
		expect(m.queries).toHaveLength(0);
	});
});
