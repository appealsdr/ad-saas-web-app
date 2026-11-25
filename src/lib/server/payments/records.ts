/**
 * The app's own record of payments executed through Stripe (migration 044).
 *
 * Two things are stored for a successful payment on a Salesforce Payment__c:
 *   1. the payment itself (`stripe_payments`), from Stripe's data only — it does not depend on Salesforce;
 *   2. the contract it paid. A contract the app created already has its `service_contracts` row; one created in
 *      Salesforce (contract first, or from an Opportunity) is copied with its line items and payment records
 *      into the `salesforce_contract*` tables.
 *
 * Everything here is idempotent: the return page, the webhook and Stripe retries may all run it.
 */
import type Stripe from 'stripe';
import { sql } from '../db';
import { sfdcQuery } from '../salesforce/client';
import { getStripe } from '../stripe';
import { soqlString } from '../salesforce/soql';

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Salesforce returns 18-character ids; 15-character ones name the same record. */
const sameSfId = (a: string, b: string) => a.slice(0, 15) === b.slice(0, 15);

/** FIELDS(ALL) queries are capped at 200 rows per request. */
const PAGE = 200;
const MAX_OFFSET = 2000;

export type SfStatus = 'applied' | 'already_paid' | 'mismatch' | 'failed';

/** Only successful payments against an existing Salesforce payment are recorded here. */
function paymentIdOf(pi: Stripe.PaymentIntent): string | null {
	const id = pi.metadata?.payment_id;
	return pi.metadata?.kind === 'balance' && pi.status === 'succeeded' && id && SF_ID.test(id) ? id : null;
}

/** Charge details are not on every PaymentIntent we receive (webhooks send only the charge id). */
async function chargeOf(pi: Stripe.PaymentIntent): Promise<Stripe.Charge | null> {
	if (pi.latest_charge && typeof pi.latest_charge !== 'string') return pi.latest_charge;
	if (!pi.latest_charge) return null;
	try {
		const full = await getStripe().paymentIntents.retrieve(pi.id, { expand: ['latest_charge'] });
		return full.latest_charge && typeof full.latest_charge !== 'string' ? full.latest_charge : null;
	} catch {
		return null; // the payment is still recorded; a later run fills the details in
	}
}

export async function recordStripePayment(pi: Stripe.PaymentIntent): Promise<void> {
	const paymentId = paymentIdOf(pi);
	if (!paymentId) return;
	const meta = pi.metadata;
	await savePayment(pi, {
		kind: 'balance',
		accountId: meta.account_id ?? null,
		sfPaymentId: paymentId,
		sfPaymentName: meta.payment_name || null,
		sfLineItemId: meta.line_item_id || null
	});
}

export type PaymentKind = 'balance' | 'checkout' | 'subscription' | 'renewal' | 'other';

export interface PaymentDetails {
	kind: PaymentKind;
	accountId: string | null;
	sfPaymentId?: string | null;
	sfPaymentName?: string | null;
	sfLineItemId?: string | null;
	invoiceId?: string | null;
	subscriptionId?: string | null;
}

/** Insert or complete the row for a PaymentIntent from Stripe's data. Never overwrites what is already known. */
export async function savePayment(pi: Stripe.PaymentIntent, d: PaymentDetails): Promise<void> {
	const meta = pi.metadata ?? {};
	const charge = await chargeOf(pi);
	const fee = Number(meta.fee_cents) || 0;
	const base = Number(meta.base_cents) || pi.amount - fee;
	const accountId = d.accountId && UUID.test(d.accountId) ? d.accountId : null;
	const userId = meta.user_id && UUID.test(meta.user_id) ? meta.user_id : null;
	const methodId = typeof pi.payment_method === 'string' ? pi.payment_method : (pi.payment_method?.id ?? null);
	const chargeId = charge?.id ?? (typeof pi.latest_charge === 'string' ? pi.latest_charge : null);
	const paidAt = new Date((charge?.created ?? pi.created ?? Math.floor(Date.now() / 1000)) * 1000);

	// The sub-selects drop ids that no longer exist instead of failing the insert on a foreign key.
	await sql`
		INSERT INTO stripe_payments (
			stripe_payment_intent_id, account_id, user_id, stripe_charge_id, stripe_payment_method_id,
			stripe_payment_method_type, stripe_receipt_email, stripe_receipt_url,
			amount_cents, fee_cents, charged_cents, currency, paid_at,
			sfdc_payment_id, sfdc_payment_name, sfdc_contract_line_item_id,
			kind, stripe_invoice_id, stripe_subscription_id
		) VALUES (
			${pi.id},
			(SELECT id FROM accounts WHERE id = ${accountId}::uuid),
			(SELECT id FROM users WHERE id = ${userId}::uuid),
			${chargeId}, ${methodId},
			${charge?.payment_method_details?.type ?? null}, ${pi.receipt_email ?? null}, ${charge?.receipt_url ?? null},
			${base}, ${fee}, ${pi.amount}, ${(pi.currency || 'usd').toUpperCase()}, ${paidAt},
			${d.sfPaymentId ?? null}, ${d.sfPaymentName ?? null}, ${d.sfLineItemId ?? null},
			${d.kind}, ${d.invoiceId ?? null}, ${d.subscriptionId ?? null}
		)
		ON CONFLICT (stripe_payment_intent_id) DO UPDATE SET
			account_id = COALESCE(stripe_payments.account_id, EXCLUDED.account_id),
			stripe_charge_id = COALESCE(stripe_payments.stripe_charge_id, EXCLUDED.stripe_charge_id),
			stripe_payment_method_type = COALESCE(stripe_payments.stripe_payment_method_type, EXCLUDED.stripe_payment_method_type),
			stripe_receipt_url = COALESCE(stripe_payments.stripe_receipt_url, EXCLUDED.stripe_receipt_url),
			sfdc_payment_id = COALESCE(stripe_payments.sfdc_payment_id, EXCLUDED.sfdc_payment_id),
			sfdc_payment_name = COALESCE(stripe_payments.sfdc_payment_name, EXCLUDED.sfdc_payment_name),
			stripe_invoice_id = COALESCE(stripe_payments.stripe_invoice_id, EXCLUDED.stripe_invoice_id),
			stripe_subscription_id = COALESCE(stripe_payments.stripe_subscription_id, EXCLUDED.stripe_subscription_id)
	`;
}

/** Whether Salesforce was updated. A later failure never downgrades a payment that was already applied. */
export async function markSalesforceStatus(paymentIntentId: string, status: SfStatus, error: string | null = null): Promise<void> {
	await sql`
		UPDATE stripe_payments SET sf_status = ${status}, sf_error = ${error?.slice(0, 1000) ?? null}
		WHERE stripe_payment_intent_id = ${paymentIntentId} AND (sf_status <> 'applied' OR ${status} = 'applied')
	`;
}

/**
 * Store the contract behind a recorded payment and link the payment to it. Throws on a database or Salesforce
 * error so the caller can retry. `refresh` re-reads a Salesforce contract that was already stored.
 */
export async function storePaidContract(pi: Stripe.PaymentIntent, opts: { refresh?: boolean } = {}): Promise<void> {
	const paymentId = paymentIdOf(pi);
	if (!paymentId) return;
	const [row] = await sql<{ account_id: string | null; contract_stored_at: Date | null }[]>`
		SELECT account_id, contract_stored_at FROM stripe_payments WHERE stripe_payment_intent_id = ${pi.id}`;
	if (!row?.account_id || (row.contract_stored_at && !opts.refresh)) return;
	const accountId = row.account_id;

	const [payment] = (
		await sfdcQuery<{ Service_Contract__c: string | null }>(
			`SELECT Service_Contract__c FROM Payment__c WHERE Id = ${soqlString(paymentId)} LIMIT 1`
		)
	).records;
	const sfContractId = payment?.Service_Contract__c;
	if (!sfContractId || !SF_ID.test(sfContractId)) return;

	const [local] = await sql<{ id: string }[]>`
		SELECT id FROM service_contracts WHERE account_id = ${accountId} AND sfdc_service_contract_id = ${sfContractId} LIMIT 1`;
	if (local) {
		await sql`
			UPDATE stripe_payments
			SET sfdc_service_contract_id = ${sfContractId}, service_contract_id = ${local.id}, contract_stored_at = now()
			WHERE stripe_payment_intent_id = ${pi.id}`;
		return;
	}

	const storedId = await copySalesforceContract(accountId, sfContractId);
	if (!storedId) return;
	await sql`
		UPDATE stripe_payments
		SET sfdc_service_contract_id = ${sfContractId}, salesforce_contract_id = ${storedId}, contract_stored_at = now()
		WHERE stripe_payment_intent_id = ${pi.id}`;
}

type SfRecord = Record<string, unknown> & { Id: string };

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Every field of every matching record. Values inside `from` go through soqlString(). */
async function allRecords(from: string): Promise<SfRecord[]> {
	const out: SfRecord[] = [];
	for (let offset = 0; offset <= MAX_OFFSET; offset += PAGE) {
		const page = await sfdcQuery<SfRecord>(
			`SELECT FIELDS(ALL) FROM ${from} ORDER BY Id LIMIT ${PAGE}${offset ? ` OFFSET ${offset}` : ''}`
		);
		out.push(...page.records);
		if (page.records.length < PAGE) return out;
	}
	throw new Error(`Too many records to copy: ${from}`);
}

/**
 * Copy a ServiceContract with its line items and payments. Returns the local id, or null when the contract does
 * not belong to this account's Salesforce Account (nothing is stored then).
 */
export async function copySalesforceContract(accountId: string, sfContractId: string): Promise<string | null> {
	if (!SF_ID.test(sfContractId)) return null;
	const [account] = await sql<{ sfdc_account_id: string | null }[]>`
		SELECT sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	if (!account?.sfdc_account_id) return null;

	const readAt = new Date();
	const [contract] = await allRecords(`ServiceContract WHERE Id = ${soqlString(sfContractId)}`);
	const owner = text(contract?.AccountId);
	if (!contract || !owner || !sameSfId(owner, account.sfdc_account_id)) return null;

	const lines = await allRecords(`ContractLineItem WHERE ServiceContractId = ${soqlString(sfContractId)}`);
	const payments = await allRecords(`Payment__c WHERE Service_Contract__c = ${soqlString(sfContractId)}`);
	// Product names live on a related object, which FIELDS(ALL) does not include.
	const products = await sfdcQuery<{ Id: string; PricebookEntry?: { Product2?: { Name?: string | null } | null } | null }>(
		`SELECT Id, PricebookEntry.Product2.Name FROM ContractLineItem WHERE ServiceContractId = ${soqlString(sfContractId)}`,
		{ paginate: true }
	);
	const productNames = new Map(products.records.map((p) => [p.Id, p.PricebookEntry?.Product2?.Name ?? null]));
	const sfStoreId = text(contract.Store__c);

	return sql.begin(async (tx) => {
		// The upsert locks the contract row, so concurrent copies run one after the other; an older read never
		// overwrites a newer one.
		const [saved] = await tx<{ id: string }[]>`
			INSERT INTO salesforce_contracts (
				account_id, store_id, sfdc_service_contract_id, sfdc_account_id, sfdc_contact_id, sfdc_store_id,
				sfdc_pricebook2_id, name, contract_number, status, start_date, end_date, data, synced_at
			) VALUES (
				${accountId},
				(SELECT id FROM stores WHERE account_id = ${accountId} AND left(sfdc_store_id, 15) = ${sfStoreId?.slice(0, 15) ?? null} LIMIT 1),
				${sfContractId}, ${owner}, ${text(contract.ContactId)}, ${sfStoreId},
				${text(contract.Pricebook2Id)}, ${text(contract.Name)}, ${text(contract.ContractNumber)}, ${text(contract.Status)},
				${text(contract.StartDate)}, ${text(contract.EndDate)}, ${tx.json(contract as never)}, ${readAt}
			)
			ON CONFLICT (sfdc_service_contract_id) DO UPDATE SET
				account_id = EXCLUDED.account_id, store_id = EXCLUDED.store_id, sfdc_account_id = EXCLUDED.sfdc_account_id,
				sfdc_contact_id = EXCLUDED.sfdc_contact_id, sfdc_store_id = EXCLUDED.sfdc_store_id,
				sfdc_pricebook2_id = EXCLUDED.sfdc_pricebook2_id, name = EXCLUDED.name,
				contract_number = EXCLUDED.contract_number, status = EXCLUDED.status, start_date = EXCLUDED.start_date,
				end_date = EXCLUDED.end_date, data = EXCLUDED.data, synced_at = EXCLUDED.synced_at
			WHERE salesforce_contracts.synced_at <= EXCLUDED.synced_at
			RETURNING id`;
		if (!saved) {
			const [newer] = await tx<{ id: string }[]>`
				SELECT id FROM salesforce_contracts WHERE sfdc_service_contract_id = ${sfContractId}`;
			return newer.id;
		}

		await tx`DELETE FROM salesforce_contract_line_items WHERE salesforce_contract_id = ${saved.id}`;
		for (const l of lines) {
			await tx`
				INSERT INTO salesforce_contract_line_items (
					sfdc_contract_line_item_id, salesforce_contract_id, product_name, description, quantity, unit_price, data
				) VALUES (
					${l.Id}, ${saved.id}, ${productNames.get(l.Id) ?? null}, ${text(l.Description)},
					${num(l.Quantity)}, ${num(l.UnitPrice)}, ${tx.json(l as never)}
				)
				ON CONFLICT (sfdc_contract_line_item_id) DO NOTHING`;
		}

		await tx`DELETE FROM salesforce_contract_payments WHERE salesforce_contract_id = ${saved.id}`;
		for (const p of payments) {
			await tx`
				INSERT INTO salesforce_contract_payments (
					sfdc_payment_id, salesforce_contract_id, name, status, payment_type, amount, total_paid,
					payment_date, paid_at, sfdc_contract_line_item_id, sfdc_opportunity_id, stripe_payment_intent_id, data
				) VALUES (
					${p.Id}, ${saved.id}, ${text(p.Name)}, ${text(p.Status__c)}, ${text(p.Payment_Type__c)},
					${num(p.Amount__c)}, ${num(p.Total_Paid__c)}, ${text(p.Payment_Date__c)}, ${text(p.PaidAt__c)},
					${text(p.Contract_Line_Item__c)}, ${text(p.Opportunity__c)}, ${text(p.Stripe_Payment_Intent_Id__c)},
					${tx.json(p as never)}
				)
				ON CONFLICT (sfdc_payment_id) DO UPDATE SET salesforce_contract_id = EXCLUDED.salesforce_contract_id`;
		}
		return saved.id;
	});
}
