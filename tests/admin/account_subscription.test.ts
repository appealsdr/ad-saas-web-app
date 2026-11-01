import { describe, expect, it } from 'vitest';
import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeStore, makeUser, uniq } from '../setup/db';
import { getAccountSubscription } from '$lib/server/subscription';

const d = describe.skipIf(!hasDb);

async function makeSubscription(accountId: string, userId: string, plan: string) {
	const [c] = await sql<{ id: string }[]>`
		INSERT INTO service_contracts (account_id, user_id, stripe_payment_intent_id, amount_cents, currency, paid_at,
		  start_date, end_date, term_months, kind, status, payment_status, stripe_subscription_id)
		VALUES (${accountId}, ${userId}, ${`pi_${uniq()}`}, 100000, 'USD', now(), current_date,
		  current_date + 365, 12, 'subscription', 'active', 'Subscription', ${`sub_${uniq()}`})
		RETURNING id`;
	await sql`INSERT INTO service_contract_line_items (service_contract_id, product_name, sfdc_pricebook_entry_id, unit_price, quantity, currency)
	          VALUES (${c.id}, ${plan}, ${`01u${uniq()}`}, 1000, 1, 'USD')`;
	return c.id;
}

d('account-level subscription', () => {
	it('is null until the account points at an active subscription, then covers the account', async () => {
		const a = await makeAccount();
		const u = await makeUser({ accountId: a.id, role: 'owner' });
		await makeStore(a.id);
		await makeStore(a.id);
		expect(await getAccountSubscription(a.id)).toBeNull();
		const id = await makeSubscription(a.id, u.id, 'Growth');
		expect(await getAccountSubscription(a.id)).toBeNull(); // contract alone is not enough
		await sql`UPDATE accounts SET active_subscription_contract_id = ${id} WHERE id = ${a.id}`;
		const sub = await getAccountSubscription(a.id);
		expect(sub).toMatchObject({ contractId: id, planName: 'Growth', price: 1000 });
		await sql`UPDATE service_contracts SET status = 'cancelled' WHERE id = ${id}`;
		expect(await getAccountSubscription(a.id)).toBeNull();
	});
	it('does not leak across accounts', async () => {
		const a = await makeAccount();
		const b = await makeAccount();
		const u = await makeUser({ accountId: a.id });
		const id = await makeSubscription(a.id, u.id, 'Essential');
		await sql`UPDATE accounts SET active_subscription_contract_id = ${id} WHERE id = ${a.id}`;
		expect(await getAccountSubscription(b.id)).toBeNull();
	});
	it('deleting the account (admin) removes its subscription contracts cleanly', async () => {
		const a = await makeAccount();
		const u = await makeUser({ accountId: a.id });
		const id = await makeSubscription(a.id, u.id, 'Growth');
		await sql`UPDATE accounts SET active_subscription_contract_id = ${id} WHERE id = ${a.id}`;
		await sql`DELETE FROM users WHERE account_id = ${a.id}`;
		await sql`DELETE FROM accounts WHERE id = ${a.id}`;
		expect(await sql`SELECT 1 FROM service_contracts WHERE id = ${id}`).toHaveLength(0);
	});
});
