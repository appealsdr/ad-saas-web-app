/**
 * Stripe subscription cancellation → local contract + Salesforce.
 *
 *  customer.subscription.updated  (cancel requested, e.g. from the Billing Portal)
 *      The subscription stays paid-for until the period ends, so the contract stays ACTIVE.
 *      We set the contract's end date to the Stripe period end, remember when cancellation
 *      was requested (the app then shows "Ends <date>"), and push the end date to the
 *      Salesforce ServiceContract. If the customer resumes, the request is cleared and the
 *      end date goes back to the current period end.
 *
 *  customer.subscription.deleted  (the period actually ended, or an immediate cancel)
 *      The contract is marked cancelled in the app and in Salesforce, and the account no
 *      longer has an active subscription (local pointer + Account/Store Service_Contract__c).
 */
import type Stripe from 'stripe';
import { sql } from './db';
import { cancelServiceContract, setAccountActiveServiceContract, setStoreActiveServiceContract } from './salesforce';
import { sobjectUpdate } from './salesforce/client';
import { logError } from './error_log';

type SubShape = Pick<Stripe.Subscription, 'id' | 'cancel_at_period_end' | 'cancel_at'> & {
	items?: { data?: { current_period_end?: number }[] };
	current_period_end?: number; // older API versions
};

/** True when the customer has asked for the subscription to end (now or at period end). */
export function isCancelling(sub: SubShape): boolean {
	return !!sub.cancel_at_period_end || sub.cancel_at != null;
}

/** The date Stripe will stop (or has stopped) billing: explicit cancel date, else the current period end. */
export function subscriptionEnd(sub: SubShape): Date | null {
	const ts = sub.cancel_at ?? sub.items?.data?.[0]?.current_period_end ?? sub.current_period_end ?? null;
	return ts ? new Date(ts * 1000) : null;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

interface ContractRow {
	id: string;
	account_id: string;
	status: string;
	end_date: Date;
	cancel_requested_at: Date | null;
	sfdc_service_contract_id: string | null;
}

async function findContract(stripeSubscriptionId: string): Promise<ContractRow | null> {
	const [c] = await sql<ContractRow[]>`
		SELECT id, account_id, status, end_date, cancel_requested_at, sfdc_service_contract_id
		FROM service_contracts WHERE stripe_subscription_id = ${stripeSubscriptionId} LIMIT 1`;
	return c ?? null;
}

async function pushEndDate(c: ContractRow, end: Date, operation: string) {
	if (!c.sfdc_service_contract_id) return;
	try {
		await sobjectUpdate('ServiceContract', c.sfdc_service_contract_id, { EndDate: day(end) });
	} catch (e) {
		await logError({
			source: 'stripe.webhook', operation, accountId: c.account_id, sfdcObject: 'ServiceContract',
			errorMessage: `Could not update the Salesforce contract end date: ${e instanceof Error ? e.message : String(e)}`,
			context: { sfdcServiceContractId: c.sfdc_service_contract_id, endDate: day(end) }
		});
	}
}

/** customer.subscription.updated */
export async function handleSubscriptionUpdated(sub: SubShape): Promise<'cancelling' | 'resumed' | 'unchanged'> {
	const c = await findContract(sub.id);
	if (!c || c.status === 'cancelled') return 'unchanged';
	const end = subscriptionEnd(sub);
	if (!end) return 'unchanged';

	if (isCancelling(sub)) {
		if (c.cancel_requested_at && day(c.end_date) === day(end)) return 'unchanged'; // already applied
		await sql`
			UPDATE service_contracts
			SET end_date = ${day(end)}, cancel_requested_at = COALESCE(cancel_requested_at, now())
			WHERE id = ${c.id}`;
		await pushEndDate(c, end, 'subscription_cancel_requested');
		return 'cancelling';
	}
	if (c.cancel_requested_at) {
		await sql`UPDATE service_contracts SET end_date = ${day(end)}, cancel_requested_at = NULL WHERE id = ${c.id}`;
		await pushEndDate(c, end, 'subscription_resumed');
		return 'resumed';
	}
	return 'unchanged';
}

/** customer.subscription.deleted */
export async function handleSubscriptionEnded(stripeSubscriptionId: string): Promise<void> {
	const [c] = await sql<(ContractRow & { store_id: string | null })[]>`
		SELECT id, account_id, store_id, status, end_date, cancel_requested_at, sfdc_service_contract_id
		FROM service_contracts WHERE stripe_subscription_id = ${stripeSubscriptionId} LIMIT 1`;
	if (!c || c.status === 'cancelled') return; // nothing local, or already handled (idempotent)

	const [acct] = await sql<{ sfdc_account_id: string | null; active: string | null }[]>`
		SELECT sfdc_account_id, active_subscription_contract_id::text AS active FROM accounts WHERE id = ${c.account_id}`;
	const wasActive = acct?.active === c.id;

	await sql`
		UPDATE service_contracts
		SET status = 'cancelled', payment_status = 'Canceled',
		    end_date = LEAST(end_date, CURRENT_DATE), cancel_requested_at = COALESCE(cancel_requested_at, now())
		WHERE id = ${c.id}`;
	await sql`UPDATE accounts SET active_subscription_contract_id = NULL WHERE id = ${c.account_id} AND active_subscription_contract_id = ${c.id}`;
	if (c.store_id) await sql`UPDATE stores SET active_service_contract_id = NULL WHERE id = ${c.store_id} AND active_service_contract_id = ${c.id}`;

	if (c.sfdc_service_contract_id) await cancelServiceContract(c.sfdc_service_contract_id, { accountId: c.account_id });

	// The account no longer has an active subscription in Salesforce either.
	if (wasActive) {
		const ctx = { accountId: c.account_id };
		if (acct?.sfdc_account_id) await setAccountActiveServiceContract(acct.sfdc_account_id, null, ctx);
		const stores = await sql<{ sfdc_store_id: string }[]>`SELECT sfdc_store_id FROM stores WHERE account_id = ${c.account_id} AND sfdc_store_id IS NOT NULL`;
		for (const s of stores) await setStoreActiveServiceContract(s.sfdc_store_id, null, ctx);
	}
}
