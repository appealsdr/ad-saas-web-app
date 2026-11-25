import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	/** Every record "created in Salesforce". */
	created: [] as { object: string; body: Record<string, unknown>; id: string }[],
	n: 0,
	catalogDown: false,
	failContractCreate: false,
	/** Holds price book reads until this many callers are waiting, so they are all past their first checks. */
	catalogBarrier: 0,
	waiting: [] as (() => void)[],
	intents: new Map<string, unknown>(),
	sessions: new Map<string, unknown>()
}));

vi.mock('$lib/server/salesforce/client', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/salesforce/client')>('$lib/server/salesforce/client');
	const tick = () => new Promise((r) => setTimeout(r, 5));
	return {
		...actual,
		sfdcQuery: vi.fn(async (soql: string) => {
			let records: unknown[] = [];
			if (soql.includes('FROM PricebookEntry')) {
				if (m.catalogBarrier) {
					await new Promise<void>((resolve) => {
						m.waiting.push(resolve);
						if (m.waiting.length >= m.catalogBarrier) m.waiting.splice(0).forEach((r) => r());
					});
				}
				if (m.catalogDown) throw new Error('Salesforce down');
				const sub = soql.includes("'Subscriptions'");
				records = [{
					Id: sub ? '01uSUB000000001' : '01uSVC000000001', UnitPrice: sub ? 1200 : 300, Pricebook2Id: '01sPRICEBOOK001',
					Product2: { Id: sub ? '01tSUB000000001' : '01tSVC000000001', Name: sub ? 'Monitoring' : 'A-Z Claims', Description: null, Family: null, Category__c: null, IsActive: true }
				}];
			}
			return { records, done: true, totalSize: records.length };
		}),
		sobjectCreate: vi.fn(async (object: string, body: Record<string, unknown>) => {
			await tick();
			if (object === 'ServiceContract' && m.failContractCreate) throw new Error('create refused');
			const id = `${object.slice(0, 3)}${String(++m.n).padStart(6, '0')}${Math.random().toString(36).slice(2, 8)}`;
			m.created.push({ object, body, id });
			return { success: true, id, errors: [] };
		}),
		sobjectUpdate: vi.fn(async () => {}),
		sobjectDelete: vi.fn(async () => {})
	};
});
vi.mock('$lib/server/stripe', () => ({
	getStripe: () => ({
		// The signature check is Stripe's; here the body is the event.
		webhooks: { constructEvent: (body: string) => JSON.parse(body) },
		paymentIntents: { retrieve: async (id: string) => structuredClone(m.intents.get(id)) },
		checkout: { sessions: { retrieve: async (id: string) => structuredClone(m.sessions.get(id)) } }
	})
}));
vi.mock('$env/dynamic/private', () => ({ env: { ...process.env, STRIPE_WEBHOOK_SECRET: 'whsec_test' } }));

import { sql } from '$lib/server/db';
import { invalidatePricebookCache } from '$lib/server/salesforce/pricebook';
import { persistContract, snapshotPaymentIntent } from '$lib/server/checkout/fulfillment';
import { hasDb, makeAccount, makeStore, makeUser, uniq } from '../setup/db';
import { POST } from '../../src/routes/api/stripe/webhook/+server';
import { load } from '../../src/routes/checkout/success/+page.server';

type Info = { localContractId: string | null; syncStatus: string; syncError?: string } | null;

async function buyer() {
	const account = await makeAccount({ sfdc: `001${uniq()}0000000` });
	const user = await makeUser({ accountId: account.id });
	const storeId = await makeStore(account.id);
	return { account, userId: user.id, storeId };
}
type Buyer = Awaited<ReturnType<typeof buyer>>;

function intent(b: Buyer, metadata: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
	const pi = {
		id: 'pi_' + uniq() + uniq(), status: 'succeeded', amount: 30927, currency: 'usd', created: 1790000000,
		payment_method: 'pm_1', payment_method_types: ['card'], latest_charge: { id: 'ch_' + uniq(), created: 1790000100 },
		receipt_email: 'payer@example.test',
		metadata: { kind: 'service', user_id: b.userId, store_id: b.storeId, pricebook_entry_ids: '01uSVC000000001', fee_cents: '927', ...metadata },
		...extra
	};
	m.intents.set(pi.id, pi);
	return pi;
}

function session(b: Buyer, extra: Record<string, unknown> = {}) {
	const s = {
		id: 'cs_' + uniq() + uniq(), payment_status: 'paid', subscription: 'sub_' + uniq() + uniq(), amount_total: 120000, currency: 'usd',
		customer_details: { email: 'payer@example.test' },
		metadata: { kind: 'subscription', user_id: b.userId, account_id: b.account.id, pricebook_entry_id: '01uSUB000000001' },
		...extra
	};
	m.sessions.set(s.id, s);
	return s;
}

async function deliver(type: string, object: unknown, id = 'evt_' + uniq() + uniq(), created = Math.floor(Date.now() / 1000)) {
	const body = JSON.stringify({ id, type, created, data: { object } });
	return POST({ request: new Request('http://app.test/api/stripe/webhook', { method: 'POST', headers: { 'stripe-signature': 'sig' }, body }) } as never);
}
const visit = async (query: string) =>
	((await load({ url: new URL(`http://app.test/checkout/success?${query}`), locals: {} } as never)) as { contractInfo: Info }).contractInfo;

const contracts = (accountId: string) =>
	sql<{ id: string; sync_status: string; sync_error: string | null; sfdc_service_contract_id: string | null; status: string; kind: string; stripe_payment_intent_id: string }[]>`
		SELECT id, sync_status, sync_error, sfdc_service_contract_id, status, kind, stripe_payment_intent_id
		FROM service_contracts WHERE account_id = ${accountId} ORDER BY created_at`;
const activeSubscription = async (accountId: string) =>
	(await sql<{ id: string | null }[]>`SELECT active_subscription_contract_id AS id FROM accounts WHERE id = ${accountId}`)[0].id;
const claimed = (eventId: string) => sql`SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id = ${eventId}`;
const made = (object: string) => m.created.filter((c) => c.object === object);
const lineCount = async (contractId: string) =>
	(await sql`SELECT 1 FROM service_contract_line_items WHERE service_contract_id = ${contractId}`).length;

/** Exactly one local contract and one set of Salesforce records. */
async function expectOnce(accountId: string, payments = 1) {
	const rows = await contracts(accountId);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({ sync_status: 'synced', sync_error: null });
	expect(await lineCount(rows[0].id)).toBe(1);
	expect(made('ServiceContract')).toHaveLength(1);
	expect(made('ServiceContract')[0].id).toBe(rows[0].sfdc_service_contract_id);
	expect(made('ContractLineItem')).toHaveLength(1);
	expect(made('Payment__c')).toHaveLength(payments);
	return rows[0];
}

beforeEach(() => {
	m.created.length = 0;
	m.catalogDown = false;
	m.failContractCreate = false;
	m.catalogBarrier = 0;
	m.waiting.length = 0;
	invalidatePricebookCache();
});

const d = describe.skipIf(!hasDb);

d('PaymentIntent purchase', () => {
	it('is stored by the webhook when the customer never reaches the success page', async () => {
		const b = await buyer();
		const pi = intent(b);
		// Webhook payloads carry only the charge id; the contract still starts at the charge time.
		expect((await deliver('payment_intent.succeeded', { ...pi, latest_charge: pi.latest_charge.id })).status).toBe(200);
		const row = await expectOnce(b.account.id);
		expect(row.stripe_payment_intent_id).toBe(pi.id);
		const [c] = await sql<{ amount_cents: string; paid_at: Date; store_id: string }[]>`SELECT amount_cents, paid_at, store_id FROM service_contracts WHERE id = ${row.id}`;
		expect([Number(c.amount_cents), c.paid_at.getTime(), c.store_id]).toEqual([30000, 1790000100000, b.storeId]);
		expect(made('Case')).toHaveLength(1);
	});

	it('is created once when the success page and the webhook run at the same time', async () => {
		for (let round = 0; round < 3; round++) {
			m.created.length = 0;
			invalidatePricebookCache();
			const b = await buyer();
			const pi = intent(b);
			m.catalogBarrier = 2;
			const [info, response] = await Promise.all([visit(`payment_intent=${pi.id}`), deliver('payment_intent.succeeded', pi)]);
			expect(response.status).toBe(200);
			const row = await expectOnce(b.account.id);
			expect(info?.localContractId).toBe(row.id);
			expect(['synced', 'pending']).toContain(info?.syncStatus);
		}
	});

	it('is created once under many concurrent callers, and exactly one of them writes to Salesforce', async () => {
		const b = await buyer();
		const pi = intent(b);
		const snapshot = await snapshotPaymentIntent(pi.id);
		const results = await Promise.all(Array.from({ length: 8 }, () => persistContract(snapshot)));
		const row = await expectOnce(b.account.id);
		expect(results.map((r) => r.localContractId)).toEqual(Array(8).fill(row.id));
		expect(results.filter((r) => r.syncStatus === 'failed')).toHaveLength(0);
	});

	it('does nothing more on a later page load, redelivery or second event', async () => {
		const b = await buyer();
		const pi = intent(b);
		const eventId = 'evt_' + uniq();
		await deliver('payment_intent.succeeded', pi, eventId);
		await deliver('payment_intent.succeeded', pi, eventId);
		await deliver('payment_intent.succeeded', pi);
		const info = await visit(`payment_intent=${pi.id}`);
		const row = await expectOnce(b.account.id);
		expect(info).toMatchObject({ localContractId: row.id, syncStatus: 'synced' });
	});

	it('creates one monthly payment set for a recurring pay-by-month purchase', async () => {
		const { env } = await import('$env/dynamic/private');
		env.SFDC_PRICE_RECURRING = 'Recurring';
		const b = await buyer();
		const pi = intent(b, { kind: 'recurring', term_months: '3', pay_option: 'monthly' });
		m.catalogBarrier = 2;
		await Promise.all([visit(`payment_intent=${pi.id}`), deliver('payment_intent.succeeded', pi)]);
		expect(await contracts(b.account.id)).toHaveLength(1);
		expect(made('ServiceContract')).toHaveLength(1);
		expect(made('ContractLineItem')).toHaveLength(3);
		expect(made('Payment__c')).toHaveLength(3);
		delete env.SFDC_PRICE_RECURRING;
	});

	it('ignores PaymentIntents that are not checkout purchases', async () => {
		const b = await buyer();
		const invoicePi = intent(b, {}, { metadata: {} });
		const balancePi = intent(b, { kind: 'balance' });
		const processing = intent(b, {}, { status: 'processing' });
		for (const pi of [invoicePi, balancePi, processing]) {
			expect((await deliver('payment_intent.succeeded', pi)).status).toBe(200);
		}
		await visit(`payment_intent=${balancePi.id}`);
		expect(await contracts(b.account.id)).toHaveLength(0);
		expect(made('ServiceContract')).toHaveLength(0);
	});

	it('fails the delivery and stores nothing while the price book is unreadable, then succeeds on the retry', async () => {
		const b = await buyer();
		const pi = intent(b);
		const eventId = 'evt_' + uniq();
		m.catalogDown = true;
		await expect(deliver('payment_intent.succeeded', pi, eventId)).rejects.toMatchObject({ status: 500 });
		expect(await claimed(eventId)).toHaveLength(0);
		expect(await contracts(b.account.id)).toHaveLength(0);
		expect(await visit(`payment_intent=${pi.id}`)).toMatchObject({ localContractId: null, syncStatus: 'failed' });

		m.catalogDown = false;
		expect((await deliver('payment_intent.succeeded', pi, eventId)).status).toBe(200);
		await expectOnce(b.account.id);
		expect(await claimed(eventId)).toHaveLength(1);
	});

	it('records a failed Salesforce create on the contract and does not repeat it', async () => {
		const b = await buyer();
		const pi = intent(b);
		m.failContractCreate = true;
		expect((await deliver('payment_intent.succeeded', pi)).status).toBe(200);
		m.failContractCreate = false;
		await deliver('payment_intent.succeeded', pi);
		expect(await visit(`payment_intent=${pi.id}`)).toMatchObject({ syncStatus: 'failed', syncError: 'create refused' });
		const rows = await contracts(b.account.id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ sync_status: 'failed', sfdc_service_contract_id: null });
		expect(made('ServiceContract')).toHaveLength(0);
	});

	it('acknowledges a purchase by a user this database does not know', async () => {
		const b = await buyer();
		const pi = intent(b, { user_id: '00000000-0000-4000-8000-000000000000' });
		expect((await deliver('payment_intent.succeeded', pi)).status).toBe(200);
		expect(await contracts(b.account.id)).toHaveLength(0);
	});
});

d('Checkout Session subscription', () => {
	it('is stored and activated by the webhook alone', async () => {
		const b = await buyer();
		const s = session(b);
		expect((await deliver('checkout.session.completed', s)).status).toBe(200);
		const row = await expectOnce(b.account.id);
		expect(row).toMatchObject({ kind: 'subscription', stripe_payment_intent_id: `checkout_session:${s.id}` });
		expect(await activeSubscription(b.account.id)).toBe(row.id);
	});

	it('is created once when the success page and both session events run at the same time', async () => {
		const b = await buyer();
		const s = session(b);
		m.catalogBarrier = 3;
		const [info] = await Promise.all([
			visit(`session_id=${s.id}`),
			deliver('checkout.session.completed', s),
			deliver('checkout.session.async_payment_succeeded', s)
		]);
		const row = await expectOnce(b.account.id);
		expect(info?.localContractId).toBe(row.id);
		expect(await activeSubscription(b.account.id)).toBe(row.id);
	});

	it('waits for the money: an unpaid session is stored only when the delayed payment succeeds', async () => {
		const b = await buyer();
		const s = session(b, { payment_status: 'unpaid' });
		await deliver('checkout.session.completed', s);
		expect(await contracts(b.account.id)).toHaveLength(0);
		await deliver('checkout.session.async_payment_succeeded', { ...s, payment_status: 'paid' });
		await expectOnce(b.account.id);
	});

	it('fails the delivery while the plan cannot be loaded, then succeeds on the retry', async () => {
		const b = await buyer();
		const s = session(b);
		const eventId = 'evt_' + uniq();
		m.catalogDown = true;
		await expect(deliver('checkout.session.completed', s, eventId)).rejects.toMatchObject({ status: 500 });
		expect(await claimed(eventId)).toHaveLength(0);
		m.catalogDown = false;
		await deliver('checkout.session.completed', s, eventId);
		await expectOnce(b.account.id);
	});

	it('replaces the previous plan, but a late delivery never replaces a newer one', async () => {
		const b = await buyer();
		const hourAgo = Math.floor(Date.now() / 1000) - 3600;
		await deliver('checkout.session.completed', session(b), undefined, hourAgo);
		const [first] = await contracts(b.account.id);

		const newer = session(b);
		await deliver('checkout.session.completed', newer);
		const second = (await contracts(b.account.id))[1];
		expect(await activeSubscription(b.account.id)).toBe(second.id);
		expect((await contracts(b.account.id))[0]).toMatchObject({ id: first.id, status: 'cancelled' });

		await deliver('checkout.session.completed', session(b), undefined, hourAgo);
		const rows = await contracts(b.account.id);
		expect(rows).toHaveLength(3);
		expect(rows[1]).toMatchObject({ id: second.id, status: 'active' });
		expect(await activeSubscription(b.account.id)).toBe(second.id);
	});
});
