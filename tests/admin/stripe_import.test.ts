import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
	contracts: [] as Row[],
	payments: [] as Row[],
	intents: new Map<string, Row>(),
	invoices: new Map<string, Row>(),
	invoiceOfIntent: new Map<string, string>(),
	sessions: new Map<string, Row>(),
	subscriptions: new Map<string, Row>(),
	sfWrites: [] as { op: string; object: string }[],
	sfDown: false
}));

vi.mock('$lib/server/salesforce/client', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/salesforce/client')>('$lib/server/salesforce/client');
	return {
		...actual,
		sfdcQuery: vi.fn(async (soql: string) => {
			if (m.sfDown) throw new Error('Salesforce down');
			const quoted = [...soql.matchAll(/'([^']*)'/g)].map((x) => x[1]);
			const by = (rows: Row[], field: string) => rows.filter((r) => quoted.includes(String(r[field])));
			let records: Row[] = [];
			if (soql.includes('FROM Payment__c')) {
				records = soql.includes('WHERE Id') ? by(m.payments, 'Id')
					: soql.includes('WHERE Stripe_Payment_Intent_Id__c') ? by(m.payments, 'Stripe_Payment_Intent_Id__c')
					: by(m.payments, 'Service_Contract__c');
			} else if (soql.includes('FROM ServiceContract')) {
				records = soql.includes('WHERE AccountId') ? by(m.contracts, 'AccountId') : by(m.contracts, 'Id');
			}
			return { records: structuredClone(records), done: true, totalSize: records.length };
		}),
		sobjectCreate: vi.fn(async (object: string, body: Row) => {
			m.sfWrites.push({ op: 'create', object });
			const id = `a1B${String(m.sfWrites.length).padStart(15, '0')}`;
			if (object === 'Payment__c') m.payments.push({ Id: id, ...body });
			return { success: true, id, errors: [] };
		}),
		sobjectUpdate: vi.fn(async (object: string, id: string, body: Row) => {
			m.sfWrites.push({ op: 'update', object });
			Object.assign(m.payments.find((p) => p.Id === id) ?? {}, body);
		})
	};
});

const notFound = () => Object.assign(new Error('No such record'), { code: 'resource_missing' });
const get = (map: Map<string, Row>, id: string) => {
	const v = map.get(id);
	if (!v) throw notFound();
	return structuredClone(v);
};
vi.mock('$lib/server/stripe', () => ({
	getStripe: () => ({
		paymentIntents: { retrieve: async (id: string) => get(m.intents, id) },
		charges: { retrieve: async () => { throw notFound(); } },
		invoices: { retrieve: async (id: string) => get(m.invoices, id) },
		invoicePayments: {
			list: async (q: { payment?: { payment_intent: string } }) => {
				const inv = q.payment && m.invoiceOfIntent.get(q.payment.payment_intent);
				return { data: inv ? [{ invoice: inv }] : [] };
			}
		},
		checkout: { sessions: { retrieve: async (id: string) => get(m.sessions, id), list: async () => ({ data: [] }) } },
		subscriptions: { retrieve: async (id: string) => get(m.subscriptions, id) }
	})
}));
vi.mock('$lib/server/salesforce/pricebook', async () => {
	const actual = await vi.importActual<Record<string, unknown>>('$lib/server/salesforce/pricebook');
	return {
		...actual,
		getCatalogProduct: vi.fn(async (id: string) => ({
			pricebookEntryId: id, pricebook2Id: '01s000000000001AAA', productId: '01t000000000001AAA', name: 'A-Z Claims',
			description: null, category: 'Service', unitPrice: 500, currency: 'USD'
		}))
	};
});

import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeUser, uniq } from '../setup/db';
import { importTransaction, lookupTransaction, pushPayment } from '$lib/server/admin/stripe_import';
import { copyFromSalesforce } from '$lib/server/admin/sf_pull';

const ctx = { actor: { userId: null, ref: 'tester@example.test', role: 'platform_admin' } };
const sfId = (prefix: string) => (prefix + uniq() + '000000000000000000').slice(0, 18);
const WHY = 'Missed transaction';

async function setup() {
	const sfAccount = sfId('001');
	const account = await makeAccount({ sfdc: sfAccount });
	const user = await makeUser({ accountId: account.id });
	return { account, user, sfAccount };
}

function intent(over: Row = {}) {
	const id = 'pi_' + uniq();
	const pi = {
		id, status: 'succeeded', amount: 51500, currency: 'usd', created: 1790000000, payment_method: 'pm_1', payment_method_types: ['card'],
		latest_charge: { id: 'ch_' + uniq(), created: 1790000000, payment_method_details: { type: 'card' }, billing_details: {} },
		customer: null, receipt_email: 'payer@example.test', description: null, metadata: {}, ...over
	};
	m.intents.set(id, pi);
	return pi;
}

function sfContractWithPayment(sfAccount: string, payment: Row = {}) {
	const contract = { Id: sfId('810'), AccountId: sfAccount, Name: 'From opportunity', StartDate: '2026-11-01', EndDate: '2027-02-01' };
	const pay = { Id: sfId('a1B'), Name: 'PN-9', Amount__c: 500, Status__c: 'Request Payment', Service_Contract__c: contract.Id, ...payment };
	m.contracts.push(contract);
	m.payments.push(pay);
	return { contract, pay };
}

const payRow = async (id: string) => (await sql<Row[]>`SELECT * FROM stripe_payments WHERE stripe_payment_intent_id = ${id}`)[0];
const contractsOf = (accountId: string) => sql<Row[]>`SELECT * FROM service_contracts WHERE account_id = ${accountId}`;

const d = describe.skipIf(!hasDb);

beforeEach(() => {
	m.sfDown = false;
	m.sfWrites.length = 0;
});

d('looking up a transaction', () => {
	it('reports what would happen and changes nothing', async () => {
		const s = await setup();
		const { contract } = sfContractWithPayment(s.sfAccount);
		const pay = m.payments.at(-1)!;
		const pi = intent({ metadata: { kind: 'balance', payment_id: pay.Id, account_id: s.account.id, base_cents: '50000', fee_cents: '1500' } });
		const p = await lookupTransaction(s.account.id, pi.id);
		expect(p).toMatchObject({ kind: 'balance', recorded: false, contractInApp: false, ownership: 'this', blocker: null, sfContractId: contract.Id, sfPaymentName: 'PN-9' });
		expect(await payRow(pi.id)).toBeUndefined();
		expect(m.sfWrites).toHaveLength(0);
	});
	it('rejects ids that are not Stripe ids, unknown ids and unfinished payments', async () => {
		const s = await setup();
		await expect(lookupTransaction(s.account.id, "pi_x' OR Id != '")).rejects.toThrow(/Stripe ID/);
		await expect(lookupTransaction(s.account.id, 'pi_missing')).rejects.toThrow(/no record/);
		const pi = intent({ status: 'requires_payment_method' });
		await expect(importTransaction(ctx, s.account.id, pi.id, WHY, true)).rejects.toThrow(/only successful/);
	});
});

d('importing', () => {
	it('saves a balance payment and copies its Salesforce contract, without writing to Salesforce; push does that', async () => {
		const s = await setup();
		const { contract, pay } = sfContractWithPayment(s.sfAccount);
		const pi = intent({ metadata: { kind: 'balance', payment_id: pay.Id, account_id: s.account.id, base_cents: '50000', fee_cents: '1500' } });
		await importTransaction(ctx, s.account.id, pi.id, WHY, false);
		expect(await payRow(pi.id)).toMatchObject({ account_id: s.account.id, kind: 'balance', sf_status: 'pending', sfdc_payment_id: pay.Id, sfdc_service_contract_id: contract.Id });
		expect((await payRow(pi.id)).salesforce_contract_id).toBeTruthy();
		expect((await payRow(pi.id)).imported_at).toBeTruthy();
		expect(m.sfWrites).toHaveLength(0);

		await pushPayment(ctx, s.account.id, pi.id, WHY);
		expect(pay.Status__c).toBe('Paid');
		expect((await payRow(pi.id)).sf_status).toBe('applied');
		await expect(pushPayment(ctx, s.account.id, pi.id, WHY)).rejects.toThrow(/already has/);
		await importTransaction(ctx, s.account.id, pi.id, WHY, false); // again: still one row
		expect(await sql`SELECT 1 FROM stripe_payments WHERE account_id = ${s.account.id}`).toHaveLength(1);
	});

	it('recreates a missed checkout purchase in the database only', async () => {
		const s = await setup();
		const pi = intent({ metadata: { kind: 'service', user_id: s.user.id, pricebook_entry_ids: '01u000000000001AAA', fee_cents: '1500' } });
		const message = await importTransaction(ctx, s.account.id, pi.id, WHY, false);
		expect(message).toContain('app only');
		const [c] = await contractsOf(s.account.id);
		expect(c).toMatchObject({ stripe_payment_intent_id: pi.id, sync_status: 'failed', sfdc_service_contract_id: null });
		expect(Number(c.amount_cents)).toBe(50000);
		expect(await payRow(pi.id)).toMatchObject({ kind: 'checkout', service_contract_id: c.id });
		expect(m.sfWrites).toHaveLength(0);
		await importTransaction(ctx, s.account.id, pi.id, WHY, false);
		expect(await contractsOf(s.account.id)).toHaveLength(1);
		await expect(pushPayment(ctx, s.account.id, pi.id, WHY)).rejects.toThrow(/Contracts tab/);
	});

	it('links a recreated purchase to the contract Salesforce already has instead of leaving a duplicate to create', async () => {
		const s = await setup();
		const pi = intent({ metadata: { kind: 'service', user_id: s.user.id, pricebook_entry_ids: '01u000000000001AAA' } });
		const { contract } = sfContractWithPayment(s.sfAccount, { Status__c: 'Paid', Stripe_Payment_Intent_Id__c: pi.id });
		await importTransaction(ctx, s.account.id, pi.id, WHY, false);
		const [c] = await contractsOf(s.account.id);
		expect(c).toMatchObject({ sfdc_service_contract_id: contract.Id, sync_status: 'synced' });
		expect((await payRow(pi.id)).sf_status).toBe('applied');
		expect(m.sfWrites).toHaveLength(0);
	});

	it('saves a missed renewal against its subscription contract and sends it to Salesforce once', async () => {
		const s = await setup();
		const sfContract = sfId('810');
		m.contracts.push({ Id: sfContract, AccountId: s.sfAccount });
		const sub = 'sub_' + uniq();
		const [local] = await sql<{ id: string }[]>`
			INSERT INTO service_contracts (account_id, stripe_payment_intent_id, stripe_subscription_id, amount_cents, currency, paid_at, start_date, end_date, kind, sfdc_service_contract_id)
			VALUES (${s.account.id}, ${'checkout_session:cs_' + uniq()}, ${sub}, 9900, 'USD', now(), '2026-01-01', '2027-01-01', 'subscription', ${sfContract}) RETURNING id`;
		const pi = intent();
		const inv = 'in_' + uniq();
		m.invoiceOfIntent.set(pi.id, inv);
		m.invoices.set(inv, { id: inv, billing_reason: 'subscription_cycle', parent: { subscription_details: { subscription: sub } } });
		m.subscriptions.set(sub, { id: sub, status: 'active' });

		await importTransaction(ctx, s.account.id, pi.id, WHY, false);
		expect(await payRow(pi.id)).toMatchObject({ kind: 'renewal', service_contract_id: local.id, sf_status: 'pending', stripe_subscription_id: sub, stripe_invoice_id: inv });
		await pushPayment(ctx, s.account.id, pi.id, WHY);
		expect(m.sfWrites).toEqual([{ op: 'create', object: 'Payment__c' }]);
		expect((await payRow(pi.id)).sf_status).toBe('applied');
	});

	it("refuses another account's transaction and asks for confirmation when nothing identifies the owner", async () => {
		const a = await setup();
		const b = await setup();
		const theirs = intent({ metadata: { kind: 'service', user_id: b.user.id, pricebook_entry_ids: '01u000000000001AAA' } });
		await expect(importTransaction(ctx, a.account.id, theirs.id, WHY, true)).rejects.toThrow(/different account/);
		expect((await lookupTransaction(a.account.id, theirs.id)).otherAccountId).toBe(b.account.id);

		const { pay } = sfContractWithPayment(sfId('001')); // a Salesforce Account nobody here is linked to
		const unlinked = intent({ metadata: { kind: 'balance', payment_id: pay.Id } });
		await expect(importTransaction(ctx, a.account.id, unlinked.id, WHY, true)).rejects.toThrow(/different account/);

		const orphan = intent();
		await expect(importTransaction(ctx, a.account.id, orphan.id, WHY, false)).rejects.toThrow(/Confirm/);
		await importTransaction(ctx, a.account.id, orphan.id, WHY, true);
		expect(await payRow(orphan.id)).toMatchObject({ account_id: a.account.id, kind: 'other', sfdc_payment_id: null });
		expect(await contractsOf(a.account.id)).toHaveLength(0);
	});

	it('does nothing while Salesforce cannot be checked', async () => {
		const s = await setup();
		const pi = intent({ metadata: { kind: 'service', user_id: s.user.id, pricebook_entry_ids: '01u000000000001AAA' } });
		m.sfDown = true;
		await expect(importTransaction(ctx, s.account.id, pi.id, WHY, false)).rejects.toThrow(/Salesforce could not be read/);
		expect(await payRow(pi.id)).toBeUndefined();
		expect(await contractsOf(s.account.id)).toHaveLength(0);
	});

	it('needs a reason', async () => {
		const s = await setup();
		await expect(importTransaction(ctx, s.account.id, intent().id, '', true)).rejects.toThrow(/reason/i);
	});
});

d('copying from Salesforce', () => {
	it("saves the account's contracts and fetches paid transactions the app never recorded", async () => {
		const s = await setup();
		const pi = intent();
		const { contract } = sfContractWithPayment(s.sfAccount, { Status__c: 'Paid', Stripe_Payment_Intent_Id__c: pi.id });
		sfContractWithPayment(sfId('001')); // another account's
		const message = await copyFromSalesforce(ctx, s.account.id, null, WHY);
		expect(message).toContain('Copied 1 contract');
		expect(message).toContain('fetched 1 missing payment');
		expect(await sql`SELECT 1 FROM salesforce_contracts WHERE account_id = ${s.account.id}`).toHaveLength(1);
		expect(await payRow(pi.id)).toMatchObject({ account_id: s.account.id, sfdc_service_contract_id: contract.Id, sf_status: 'applied' });
		expect((await payRow(pi.id)).salesforce_contract_id).toBeTruthy();
		expect(m.sfWrites).toHaveLength(0);
		expect(await copyFromSalesforce(ctx, s.account.id, contract.Id as string, WHY)).toContain('fetched 0');
	});
	it("will not copy a contract of another account", async () => {
		const s = await setup();
		const { contract } = sfContractWithPayment(sfId('001'));
		await expect(copyFromSalesforce(ctx, s.account.id, contract.Id as string, WHY)).rejects.toThrow(/Nothing was copied/);
	});
});
