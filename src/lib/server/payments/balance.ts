/**
 * Paying a deposit balance with Stripe — against the EXISTING Salesforce Payment__c record.
 *
 *   Status__c 'Not Active'      balance not collectible yet (UI: Not Active, no Pay button)
 *   Status__c 'Request Payment' collectible (UI: Ready to pay, Pay enabled) — set by case completion
 *                               or an authorised payment request in Salesforce
 *   Status__c 'Paid'            collected
 *
 * The Pay button is only a convenience: collectibility is enforced HERE by re-reading Status__c from
 * Salesforce, so showing a row never makes it payable. No new Payment__c is ever created for a
 * balance — the same record is updated to Paid with the Stripe details.
 */
import { feeForMethod } from './fees';
import type Stripe from 'stripe';
import { sql } from '../db';
import { sfdcQuery } from '../salesforce/client';
import { sobjectUpdate } from '../salesforce/client';
import { getStripe } from '../stripe';
import { markSalesforceStatus, recordStripePayment, storePaidContract, type SfStatus } from './records';
import { logError } from '../error_log';
import { normalizeMethod, type FeeBreakdown } from '../../payments/fees';
import { isSalesforceId, soqlString } from '../salesforce/soql';

export const STATUS_REQUEST = 'Request Payment';
export const STATUS_INACTIVE = 'Not Active';

export interface SfBalancePayment {
	Id: string; Name: string; Amount__c: number | null; Status__c: string | null; Payment_Type__c: string | null;
	Description__c: string | null; Service_Contract__c: string | null; Contract_Line_Item__c: string | null;
	Stripe_Payment_Intent_Id__c: string | null;
}
export interface OwnedPayment { payment: SfBalancePayment; contractId: string; currency: string; accountId: string }

export { isSalesforceId as isSfId };

/** A Payment__c, but only if it belongs to a contract of THIS account (tenancy). */
export async function getOwnedPayment(accountId: string, sfPaymentId: string): Promise<OwnedPayment | null> {
	if (!isSalesforceId(sfPaymentId)) return null;
	const res = await sfdcQuery<SfBalancePayment>(
		`SELECT Id, Name, Amount__c, Status__c, Payment_Type__c, Description__c, Service_Contract__c, Contract_Line_Item__c, Stripe_Payment_Intent_Id__c
		 FROM Payment__c WHERE Id = ${soqlString(sfPaymentId)} LIMIT 1`
	);
	const p = res.records[0];
	if (!p?.Service_Contract__c) return null;
	const [c] = await sql<{ id: string; currency: string }[]>`
		SELECT id, currency FROM service_contracts WHERE account_id = ${accountId} AND sfdc_service_contract_id = ${p.Service_Contract__c} LIMIT 1`;
	if (c) return { payment: p, contractId: c.id, currency: c.currency, accountId };
	// Contract that lives only in Salesforce (linked through a sign-up link): it belongs to this account
	// when its ServiceContract.AccountId is the account's linked Salesforce Account.
	const [acct] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	if (!acct?.sfdc_account_id || !isSalesforceId(acct.sfdc_account_id)) return null;
	const sc = await sfdcQuery<{ Id: string }>(
		`SELECT Id FROM ServiceContract WHERE Id = ${soqlString(p.Service_Contract__c)} AND AccountId = ${soqlString(acct.sfdc_account_id)} LIMIT 1`
	);
	return sc.records[0] ? { payment: p, contractId: p.Service_Contract__c, currency: 'usd', accountId } : null;
}

const cents = (n: number) => Math.round(n * 100);

/** Payable only when Salesforce says so: a balance in 'Request Payment' with a positive amount. */
export function assertCollectible(p: SfBalancePayment): void {
	if (p.Status__c !== STATUS_REQUEST) throw new BalanceError('This payment is not ready to be paid yet.', 409);
	if (!p.Amount__c || p.Amount__c <= 0 || cents(p.Amount__c) < 50) throw new BalanceError('This payment has no payable amount.', 409);
}

export class BalanceError extends Error {
	constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 502 = 400) { super(message); }
}

/**
 * PaymentIntent for that exact record and amount. The idempotency key (record + amount) means a reload or a
 * second click returns the SAME PaymentIntent, so a balance can never be charged twice in parallel.
 */
export async function createBalanceIntent(
	owned: OwnedPayment,
	user: { id: string; email: string; displayName?: string | null },
	stripeCustomerId?: string
): Promise<{ clientSecret: string; amountCents: number; currency: string; intentId: string; feeCents: number; chargeCents: number; fee: FeeBreakdown }> {
	const p = owned.payment;
	assertCollectible(p);
	const baseCents = cents(p.Amount__c!);
	const fee = feeForMethod(baseCents, 'card'); // re-priced when the client picks another payment method
	const amountCents = baseCents; // the price
	const chargeCents = fee.totalCents; // price + Stripe fee
	const description = [p.Description__c?.trim() || 'Service balance', `Payment ${p.Name}`].join(' — ');
	const intent = await getStripe().paymentIntents.create(
		{
			amount: chargeCents,
			currency: owned.currency.toLowerCase(),
			automatic_payment_methods: { enabled: true },
			receipt_email: user.email,
			description,
			...(stripeCustomerId ? { customer: stripeCustomerId } : {}),
			metadata: {
				base_cents: String(baseCents), fee_cents: String(fee.feeCents), fee_method: fee.method,
				kind: 'balance', payment_id: p.Id, payment_name: p.Name, contract_id: owned.contractId,
				line_item_id: p.Contract_Line_Item__c ?? '', user_id: user.id, account_id: owned.accountId
			}
		},
		{ idempotencyKey: `balance-${p.Id}-${chargeCents}` }
	);
	if (!intent.client_secret) throw new BalanceError('Could not start the payment.', 502);
	return { clientSecret: intent.client_secret, amountCents, currency: owned.currency, intentId: intent.id, feeCents: fee.feeCents, chargeCents, fee };
}

/**
 * Apply a SUCCEEDED balance PaymentIntent to its existing Payment__c: Stripe details, payment date, Status Paid.
 * Called from the return page AND the webhook — the first caller claims the PaymentIntent, later calls (and
 * Stripe retries) are no-ops. Never inserts a Payment__c.
 *
 * The payment and its contract are also stored in the app (records.ts). That never blocks the Salesforce update;
 * the webhook calls `ensurePaymentStored` to retry whatever could not be stored here.
 */
export async function applyBalancePaid(pi: Stripe.PaymentIntent): Promise<'applied' | 'already' | 'ignored' | 'mismatch'> {
	if (pi.metadata?.kind !== 'balance' || !pi.metadata.payment_id) return 'ignored';
	if (pi.status !== 'succeeded') return 'ignored';
	const paymentId = pi.metadata.payment_id;
	if (!isSalesforceId(paymentId)) return 'ignored';

	await bestEffort(pi, 'record_payment', () => recordStripePayment(pi));

	const claimed = await sql<{ stripe_payment_intent_id: string }[]>`
		INSERT INTO balance_payment_applications (stripe_payment_intent_id, sfdc_payment_id) VALUES (${pi.id}, ${paymentId})
		ON CONFLICT (stripe_payment_intent_id) DO NOTHING RETURNING stripe_payment_intent_id`;
	if (!claimed.length) {
		await bestEffort(pi, 'store_contract', () => storePaidContract(pi));
		return 'already';
	}

	const finish = async (status: SfStatus) => {
		await bestEffort(pi, 'mark_payment', () => markSalesforceStatus(pi.id, status));
		await bestEffort(pi, 'store_contract', () => storePaidContract(pi, { refresh: true }));
	};

	try {
		const res = await sfdcQuery<SfBalancePayment>(
			`SELECT Id, Name, Amount__c, Status__c, Payment_Type__c, Description__c, Service_Contract__c, Contract_Line_Item__c, Stripe_Payment_Intent_Id__c FROM Payment__c WHERE Id = ${soqlString(paymentId)} LIMIT 1`
		);
		const rec = res.records[0];
		if (!rec) throw new Error('Payment__c not found.');
		if (rec.Status__c === 'Paid') {
			// Paid by something else — never re-apply.
			await finish(rec.Stripe_Payment_Intent_Id__c === pi.id ? 'applied' : 'already_paid');
			return 'already';
		}
		const piFee = Number(pi.metadata?.fee_cents) || 0;
		const baseCents = Number(pi.metadata.base_cents ?? pi.amount - piFee);
		if (cents(rec.Amount__c ?? 0) !== baseCents) {
			await logError({ source: 'payments.balance', operation: 'amount_mismatch', accountId: pi.metadata.account_id, errorMessage: `Stripe charged ${pi.amount} cents but ${rec.Name} is ${rec.Amount__c}.`, context: { paymentIntentId: pi.id, paymentId } });
			await sql`DELETE FROM balance_payment_applications WHERE stripe_payment_intent_id = ${pi.id}`;
			await finish('mismatch');
			return 'mismatch';
		}
		const pm = typeof pi.payment_method === 'string' ? pi.payment_method : pi.payment_method?.id ?? null;
		const paidAt = new Date((pi.created ?? Math.floor(Date.now() / 1000)) * 1000);
		await sobjectUpdate('Payment__c', paymentId, {
			Status__c: 'Paid',
			PaidAt__c: paidAt.toISOString(),
			Payment_Date__c: paidAt.toISOString().slice(0, 10), // the day the client paid via Stripe
			Total_Paid__c: (pi.amount - piFee) / 100, // the price; the pass-through Stripe fee is not revenue
			Stripe_Payment_Intent_Id__c: pi.id,
			...(pm ? { Payment_Method__c: pm } : {})
		});
		await finish('applied');
		return 'applied';
	} catch (e) {
		// Let a retry (webhook redelivery / reload) try again.
		await sql`DELETE FROM balance_payment_applications WHERE stripe_payment_intent_id = ${pi.id}`.catch(() => {});
		await bestEffort(pi, 'mark_payment', () => markSalesforceStatus(pi.id, 'failed', e instanceof Error ? e.message : String(e)));
		await logError({
			source: 'payments.balance', operation: 'apply_paid', accountId: pi.metadata.account_id,
			errorMessage: e instanceof Error ? e.message : String(e), context: { paymentIntentId: pi.id, paymentId }
		});
		throw e;
	}
}

/** Store in the app whatever is still missing for a successful payment. Throws, so a webhook can be retried. */
export async function ensurePaymentStored(pi: Stripe.PaymentIntent): Promise<void> {
	await recordStripePayment(pi);
	await storePaidContract(pi);
}

/** Local record keeping must not turn a collected payment into an error for the customer. */
async function bestEffort(pi: Stripe.PaymentIntent, operation: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
	} catch (e) {
		await logError({
			source: 'payments.records', operation, accountId: pi.metadata?.account_id,
			errorMessage: e instanceof Error ? e.message : String(e), context: { paymentIntentId: pi.id, paymentId: pi.metadata?.payment_id }
		});
	}
}

// ─── Stripe documents (receipt / invoice) ──────────────────────────────────

export interface PaymentDocuments { receiptUrl: string | null; invoiceUrl: string | null }

/** Receipt and invoice links for a PaymentIntent. Each is null when Stripe has no such document. */
export async function stripeDocuments(paymentIntentId: string | null | undefined): Promise<PaymentDocuments> {
	const none = { receiptUrl: null, invoiceUrl: null };
	if (!paymentIntentId || !/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return none;
	const stripe = getStripe();
	try {
		const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
		const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
		const receiptUrl = charge?.receipt_url ?? null;
		let invoiceId: string | null = null;
		const legacy = (pi as unknown as { invoice?: string | { id: string } | null }).invoice;
		if (legacy) invoiceId = typeof legacy === 'string' ? legacy : legacy.id;
		if (!invoiceId) {
			try {
				const ip = await (stripe as unknown as { invoicePayments: { list: (p: unknown) => Promise<{ data: { invoice: string | { id: string } }[] }> } })
					.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1 });
				const inv = ip.data[0]?.invoice;
				if (inv) invoiceId = typeof inv === 'string' ? inv : inv.id;
			} catch { /* no invoice linked */ }
		}
		let invoiceUrl: string | null = null;
		if (invoiceId) {
			const inv = await stripe.invoices.retrieve(invoiceId);
			invoiceUrl = inv.invoice_pdf ?? inv.hosted_invoice_url ?? null;
		}
		return { receiptUrl, invoiceUrl };
	} catch {
		return none;
	}
}


/**
 * Re-price an unconfirmed PaymentIntent for the payment method the client just selected. The base amount comes
 * from the intent's own metadata (set server-side), never from the browser; only the method TYPE is client input
 * and it is whitelisted by normalizeMethod.
 */
export async function repriceIntentForMethod(intentId: string, accountId: string | null, methodType: string | null | undefined, userId?: string): Promise<FeeBreakdown> {
	const stripe = getStripe();
	const pi = await stripe.paymentIntents.retrieve(intentId);
	const owns = accountId !== null ? pi.metadata?.account_id === accountId : !!userId && pi.metadata?.user_id === userId;
	if (!owns) throw new BalanceError('Payment not found.', 404);
	if (pi.status !== 'requires_payment_method' && pi.status !== 'requires_confirmation') throw new BalanceError('This payment can no longer be changed.', 409);
	const baseCents = Number(pi.metadata.base_cents);
	if (!Number.isInteger(baseCents) || baseCents < 50) throw new BalanceError('Payment not found.', 404);
	const fee = feeForMethod(baseCents, normalizeMethod(methodType));
	if (fee.totalCents !== pi.amount) {
		await stripe.paymentIntents.update(intentId, {
			amount: fee.totalCents,
			metadata: { fee_cents: String(fee.feeCents), fee_method: fee.method }
		});
	}
	return fee;
}
