/**
 * Admin: recover a transaction the app missed, from its Stripe id (migrations 044/045).
 *
 *   lookup  — read-only: what Stripe says, whose it is, what the app and Salesforce already have.
 *   import  — save it in the app database: the payment, plus its contract (created from the purchase, linked,
 *             or copied from Salesforce). Never writes to Salesforce.
 *   push    — the other direction: record an imported payment in Salesforce.
 *
 * A transaction is only imported into the account the evidence points to. Evidence for another account refuses
 * it; no evidence at all needs the admin's explicit confirmation.
 */
import type Stripe from 'stripe';
import { sql } from '../db';
import { sfdcQuery } from '../salesforce/client';
import { createPayment } from '../salesforce';
import { getStripe } from '../stripe';
import { logError, describeError } from '../error_log';
import { applyBalancePaid, getOwnedPayment } from '../payments/balance';
import { copySalesforceContract, markSalesforceStatus, savePayment, type PaymentKind } from '../payments/records';
import { isCheckoutPaymentIntent, persistContract, persistSubscriptionContract, snapshotPaymentIntent } from '../checkout/fulfillment';
import { recordAudit, type AuditActor } from './audit';
import { ActionError, requireReason } from './actions';

interface Ctx { actor: AuditActor; ip?: string | null }

const SF_ID = /^[a-zA-Z0-9]{15,18}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRIPE_ID = /^(pi|ch|py|cs|in)_[A-Za-z0-9_]+$/;

const idOf = (v: string | { id: string } | null | undefined): string | null => (typeof v === 'string' ? v : (v?.id ?? null));

// ─── Reading Stripe ────────────────────────────────────────────────────────

interface Found {
	pi: Stripe.PaymentIntent;
	session: Stripe.Checkout.Session | null;
	invoiceId: string | null;
	billingReason: string | null;
	subscription: Stripe.Subscription | null;
	subscriptionId: string | null;
}

async function invoiceOfIntent(stripe: Stripe, paymentIntentId: string): Promise<Stripe.Invoice | null> {
	const list = await stripe.invoicePayments.list({ payment: { type: 'payment_intent', payment_intent: paymentIntentId }, limit: 1 });
	const id = idOf(list.data[0]?.invoice as string | { id: string } | undefined);
	return id ? stripe.invoices.retrieve(id) : null;
}

async function intentOfInvoice(stripe: Stripe, invoiceId: string): Promise<string | null> {
	const list = await stripe.invoicePayments.list({ invoice: invoiceId, limit: 10 });
	for (const p of list.data) {
		if (p.payment?.type === 'payment_intent') return idOf(p.payment.payment_intent);
	}
	return null;
}

/** Resolve a PaymentIntent (pi_), charge (ch_/py_), Checkout Session (cs_) or invoice (in_) id. */
async function findInStripe(input: string): Promise<Found> {
	const id = input.trim();
	if (!STRIPE_ID.test(id)) {
		throw new ActionError('Enter a Stripe ID that starts with pi_, ch_, py_, cs_ or in_.', 422);
	}
	const stripe = getStripe();
	try {
		let session: Stripe.Checkout.Session | null = null;
		let piId: string | null = null;
		if (id.startsWith('pi_')) piId = id;
		else if (id.startsWith('ch_') || id.startsWith('py_')) piId = idOf((await stripe.charges.retrieve(id)).payment_intent);
		else if (id.startsWith('in_')) piId = await intentOfInvoice(stripe, id);
		else {
			session = await stripe.checkout.sessions.retrieve(id);
			piId = idOf(session.payment_intent) ?? (session.invoice ? await intentOfInvoice(stripe, idOf(session.invoice)!) : null);
		}
		if (!piId) throw new ActionError('Stripe has no payment for this ID (nothing was charged, or it is not a card/bank payment).', 404);

		const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
		const invoice = await invoiceOfIntent(stripe, pi.id);
		const subscriptionId =
			idOf(session?.subscription) ?? idOf(invoice?.parent?.subscription_details?.subscription);
		// The first charge of a subscription is stored from its Checkout Session.
		if (!session && subscriptionId && invoice?.billing_reason === 'subscription_create') {
			session = (await stripe.checkout.sessions.list({ subscription: subscriptionId, limit: 1 })).data[0] ?? null;
		}
		const subscription = subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null;
		return { pi, session, invoiceId: invoice?.id ?? null, billingReason: invoice?.billing_reason ?? null, subscription, subscriptionId };
	} catch (e) {
		if (e instanceof ActionError) throw e;
		const code = (e as { code?: string })?.code;
		if (code === 'resource_missing') throw new ActionError('Stripe has no record with this ID (check the live / test mode).', 404);
		throw new ActionError(`Stripe could not be read: ${describeError(e).errorMessage}`, 502);
	}
}

function classify(f: Found): PaymentKind {
	if (f.pi.metadata?.kind === 'balance') return 'balance';
	if (isCheckoutPaymentIntent(f.pi)) return 'checkout';
	if (f.session?.metadata?.kind === 'subscription' && f.billingReason !== 'subscription_cycle') return 'subscription';
	if (f.subscriptionId) return 'renewal';
	return 'other';
}

// ─── What the app and Salesforce already know ──────────────────────────────

interface SfPay { Id: string; Name: string | null; Status__c: string | null; Service_Contract__c: string | null; Stripe_Payment_Intent_Id__c: string | null }
const SF_PAY_FIELDS = 'Id, Name, Status__c, Service_Contract__c, Stripe_Payment_Intent_Id__c';

interface Known {
	kind: PaymentKind;
	localContract: { id: string; account_id: string; sfdc_service_contract_id: string | null } | null;
	recorded: { account_id: string | null; sf_status: string } | null;
	/** The Salesforce payment record(s) for this transaction. */
	sfPayment: SfPay | null;
	sfContractId: string | null;
	sfError: string | null;
}

async function whatWeKnow(f: Found): Promise<Known> {
	const kind = classify(f);
	const keys = [f.pi.id, ...(f.session ? [`checkout_session:${f.session.id}`] : [])];
	const [localContract] = await sql<NonNullable<Known['localContract']>[]>`
		SELECT id, account_id, sfdc_service_contract_id FROM service_contracts
		WHERE stripe_payment_intent_id IN ${sql(keys)} OR stripe_subscription_id = ${f.subscriptionId}
		ORDER BY paid_at DESC LIMIT 1`;
	const [recorded] = await sql<NonNullable<Known['recorded']>[]>`
		SELECT account_id, sf_status FROM stripe_payments WHERE stripe_payment_intent_id = ${f.pi.id}`;

	let sfPayment: SfPay | null = null;
	let sfError: string | null = null;
	try {
		const balanceId = kind === 'balance' ? f.pi.metadata.payment_id : null;
		// `keys` come from Stripe and match STRIPE_ID, so they are safe inside the query.
		const where = balanceId && SF_ID.test(balanceId)
			? `Id = '${balanceId}'`
			: `Stripe_Payment_Intent_Id__c IN (${keys.filter((k) => /^[A-Za-z0-9_:]+$/.test(k)).map((k) => `'${k}'`).join(',')})`;
		sfPayment = (await sfdcQuery<SfPay>(`SELECT ${SF_PAY_FIELDS} FROM Payment__c WHERE ${where} ORDER BY CreatedDate ASC LIMIT 1`)).records[0] ?? null;
	} catch (e) {
		sfError = describeError(e).errorMessage;
	}
	const fromSf = sfPayment?.Service_Contract__c ?? null;
	const sfContractId = fromSf && SF_ID.test(fromSf) ? fromSf : (localContract?.sfdc_service_contract_id ?? null);
	// The app may hold this contract under another Stripe key (e.g. a later payment on a purchase made here).
	let contract: Known['localContract'] = localContract ?? null;
	if (!contract && sfContractId) {
		const [row] = await sql<NonNullable<Known['localContract']>[]>`
			SELECT id, account_id, sfdc_service_contract_id FROM service_contracts WHERE sfdc_service_contract_id = ${sfContractId} LIMIT 1`;
		contract = row ?? null;
	}
	return { kind, localContract: contract, recorded: recorded ?? null, sfPayment, sfContractId, sfError };
}

export type Ownership = 'this' | 'unverified' | 'other';

/** Every account the transaction points to, following account merges. */
async function ownership(accountId: string, f: Found, k: Known): Promise<{ state: Ownership; evidence: string[]; otherAccountId: string | null }> {
	const claims: { source: string; accountId: string }[] = [];
	const add = (source: string, id: string | null | undefined) => { if (id && UUID.test(id)) claims.push({ source, accountId: id }); };
	add('Contract in the app', k.localContract?.account_id);
	add('Recorded payment', k.recorded?.account_id);
	const meta = f.pi.metadata ?? {};
	if (k.kind === 'balance') add('Payment details in Stripe', meta.account_id);
	if (k.kind === 'subscription') add('Checkout details in Stripe', f.session?.metadata?.account_id);
	if (k.kind === 'checkout' && UUID.test(meta.user_id ?? '')) {
		const [u] = await sql<{ account_id: string | null }[]>`SELECT account_id FROM users WHERE id = ${meta.user_id}`;
		add('Buyer in Stripe', u?.account_id);
	}
	const customer = idOf(f.pi.customer);
	if (customer) {
		const [a] = await sql<{ id: string }[]>`SELECT id FROM accounts WHERE stripe_customer_id = ${customer}`;
		add('Stripe customer', a?.id);
	}
	if (k.sfContractId && !k.sfError) {
		const sc = (await sfdcQuery<{ AccountId: string | null }>(`SELECT AccountId FROM ServiceContract WHERE Id = '${k.sfContractId}' LIMIT 1`)).records[0];
		if (sc?.AccountId && SF_ID.test(sc.AccountId)) {
			const [a] = await sql<{ id: string }[]>`
				SELECT id FROM accounts WHERE left(sfdc_account_id, 15) = ${sc.AccountId.slice(0, 15)}
				ORDER BY (id = ${accountId}) DESC LIMIT 1`;
			// A contract of a Salesforce Account no platform account is linked to still rules this account out.
			claims.push({ source: 'Salesforce contract', accountId: a?.id ?? 'unlinked' });
		}
	}

	const evidence: string[] = [];
	for (const c of claims) {
		let owner = c.accountId;
		if (owner !== 'unlinked') {
			const [row] = await sql<{ id: string }[]>`SELECT COALESCE(merged_into_account_id, id) AS id FROM accounts WHERE id = ${owner}`;
			if (!row) continue; // the account no longer exists
			owner = row.id;
		}
		if (owner !== accountId) return { state: 'other', evidence: [c.source], otherAccountId: owner === 'unlinked' ? null : owner };
		evidence.push(c.source);
	}
	return { state: evidence.length ? 'this' : 'unverified', evidence, otherAccountId: null };
}

// ─── Lookup ────────────────────────────────────────────────────────────────

const KIND_LABEL: Record<PaymentKind, string> = {
	balance: 'Payment on a Salesforce payment record',
	checkout: 'Checkout purchase',
	subscription: 'New subscription',
	renewal: 'Subscription renewal',
	other: 'Other Stripe payment'
};

function plan(k: Known): string {
	const contract = k.localContract
		? 'link it to the contract already in the app'
		: k.kind === 'checkout' || k.kind === 'subscription'
			? k.sfContractId ? 'create the missing contract in the app and link it to the existing Salesforce contract' : 'create the missing contract in the app (not sent to Salesforce)'
			: k.sfContractId ? 'copy its contract from Salesforce' : 'save it without a contract (none was found)';
	return `Save the payment and ${contract}.`;
}

export interface TransactionPreview {
	id: string;
	paymentIntentId: string;
	kind: PaymentKind;
	kindLabel: string;
	status: string;
	amount: number;
	currency: string;
	paidAt: string;
	email: string | null;
	description: string | null;
	recorded: boolean;
	contractInApp: boolean;
	sfPaymentName: string | null;
	sfPaymentStatus: string | null;
	sfContractId: string | null;
	sfError: string | null;
	ownership: Ownership;
	evidence: string[];
	otherAccountId: string | null;
	plan: string;
	/** Why it cannot be imported, or null. */
	blocker: string | null;
}

async function inspect(accountId: string, input: string) {
	const found = await findInStripe(input);
	const known = await whatWeKnow(found);
	const owner = await ownership(accountId, found, known).catch((e) => {
		throw new ActionError(`The owner could not be checked: ${describeError(e).errorMessage}`, 502);
	});
	const blocker =
		found.pi.status !== 'succeeded'
			? `Stripe status is "${found.pi.status}" — only successful payments can be imported.`
			: owner.state === 'other'
				? 'This transaction belongs to a different account.'
				: known.sfError
					? 'Salesforce could not be read, so existing records cannot be checked. Try again shortly.'
					: null;
	return { found, known, owner, blocker };
}

export async function lookupTransaction(accountId: string, input: string): Promise<TransactionPreview> {
	const { found, known, owner, blocker } = await inspect(accountId, input);
	const { pi } = found;
	const charge = pi.latest_charge && typeof pi.latest_charge !== 'string' ? pi.latest_charge : null;
	return {
		id: input.trim(),
		paymentIntentId: pi.id,
		kind: known.kind,
		kindLabel: KIND_LABEL[known.kind],
		status: pi.status,
		amount: pi.amount / 100,
		currency: pi.currency.toUpperCase(),
		paidAt: new Date((charge?.created ?? pi.created) * 1000).toISOString(),
		email: pi.receipt_email ?? charge?.billing_details?.email ?? null,
		description: pi.description ?? null,
		recorded: !!known.recorded,
		contractInApp: !!known.localContract,
		sfPaymentName: known.sfPayment?.Name ?? null,
		sfPaymentStatus: known.sfPayment?.Status__c ?? null,
		sfContractId: known.sfContractId,
		sfError: known.sfError,
		ownership: owner.state,
		evidence: owner.evidence,
		otherAccountId: owner.otherAccountId,
		plan: plan(known),
		blocker
	};
}

// ─── Import (Stripe → database) ────────────────────────────────────────────

export async function importTransaction(
	ctx: Ctx,
	accountId: string,
	input: string,
	reason: string | null,
	confirmUnverified: boolean
): Promise<string> {
	const why = requireReason(reason);
	const { found, known, owner, blocker } = await inspect(accountId, input);
	if (blocker) throw new ActionError(blocker, known.sfError ? 502 : 409);
	if (owner.state === 'unverified' && !confirmUnverified) {
		throw new ActionError('Nothing links this transaction to an account. Confirm that it belongs to this one.', 409);
	}
	const { pi } = found;
	const audit = (outcome: 'success' | 'failure', metadata: Record<string, unknown>) =>
		recordAudit(
			{ actor: ctx.actor, action: 'payment.stripe_import', targetType: 'account', targetId: accountId, targetAccountId: accountId, outcome, reason: why, ip: ctx.ip, metadata: { paymentIntentId: pi.id, kind: known.kind, ownership: owner.state, ...metadata } },
			undefined,
			{ bestEffort: true }
		);
	try {
		const message = await store(accountId, found, known);
		await audit('success', { message });
		return message;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await audit('failure', { error: msg });
		throw e instanceof ActionError ? e : new ActionError(`Import failed: ${msg}`, 502);
	}
}

async function store(accountId: string, found: Found, known: Known): Promise<string> {
	const { pi, session, subscription } = found;
	const done: string[] = [];
	let localId = known.localContract?.id ?? null;
	const importOptions = {
		existingSfContractId: known.sfContractId,
		active: !subscription || ['active', 'trialing', 'past_due'].includes(subscription.status)
	};

	// A purchase whose contract was never saved.
	if (!localId && (known.kind === 'checkout' || known.kind === 'subscription')) {
		const result =
			known.kind === 'checkout'
				? await persistContract(await snapshotPaymentIntent(pi.id), null, importOptions)
				: await persistSubscriptionContract(session!, { accountId, importOptions, paidAt: new Date(pi.created * 1000) });
		if (!result?.localContractId) throw new ActionError(`The contract could not be created: ${result?.syncError ?? 'the checkout session is not a paid subscription.'}`, 422);
		localId = result.localContractId;
		done.push(result.syncStatus === 'synced' ? 'contract created and linked to Salesforce' : 'contract created in the app only');
	}

	const sf = known.sfPayment;
	await savePayment(pi, {
		kind: known.kind,
		accountId,
		sfPaymentId: sf?.Id ?? (known.kind === 'balance' ? pi.metadata.payment_id : null),
		sfPaymentName: sf?.Name ?? pi.metadata?.payment_name ?? null,
		sfLineItemId: pi.metadata?.line_item_id || null,
		invoiceId: found.invoiceId,
		subscriptionId: found.subscriptionId
	});
	await sql`UPDATE stripe_payments SET imported_at = COALESCE(imported_at, now()) WHERE stripe_payment_intent_id = ${pi.id}`;
	done.unshift(known.recorded ? 'payment already recorded, details refreshed' : 'payment saved');

	// Reflect what Salesforce already shows.
	if (sf && (sf.Status__c === 'Paid' || known.kind !== 'balance')) {
		const mine = !sf.Stripe_Payment_Intent_Id__c || sf.Stripe_Payment_Intent_Id__c === pi.id || known.kind !== 'balance';
		await markSalesforceStatus(pi.id, mine ? 'applied' : 'already_paid');
	}

	if (localId) {
		await sql`
			UPDATE stripe_payments SET service_contract_id = ${localId}, sfdc_service_contract_id = ${known.sfContractId}, contract_stored_at = now()
			WHERE stripe_payment_intent_id = ${pi.id}`;
		done.push('linked to its contract');
	} else if (known.sfContractId) {
		const copied = await copySalesforceContract(accountId, known.sfContractId);
		if (!copied) throw new ActionError('The payment was saved, but its Salesforce contract does not belong to this account\'s Salesforce Account.', 409);
		await sql`
			UPDATE stripe_payments SET salesforce_contract_id = ${copied}, sfdc_service_contract_id = ${known.sfContractId}, contract_stored_at = now()
			WHERE stripe_payment_intent_id = ${pi.id}`;
		done.push('contract copied from Salesforce');
	} else {
		done.push('no contract found for it');
	}
	const text = done.join(', ');
	return `${text[0].toUpperCase()}${text.slice(1)}.`;
}

// ─── Push (database → Salesforce) ──────────────────────────────────────────

export async function pushPayment(ctx: Ctx, accountId: string, paymentIntentId: string, reason: string | null): Promise<string> {
	const why = requireReason(reason);
	const [row] = await sql<{ kind: PaymentKind; sf_status: string; sfdc_payment_id: string | null; service_contract_id: string | null; amount_cents: string; currency: string; paid_at: Date }[]>`
		SELECT kind, sf_status, sfdc_payment_id, service_contract_id, amount_cents::text AS amount_cents, currency, paid_at
		FROM stripe_payments WHERE stripe_payment_intent_id = ${paymentIntentId} AND account_id = ${accountId}`;
	if (!row) throw new ActionError('Payment not found on this account.', 404);
	if (row.sf_status === 'applied') throw new ActionError('Salesforce already has this payment.', 409);

	const audit = (outcome: 'success' | 'failure', metadata: Record<string, unknown>) =>
		recordAudit(
			{ actor: ctx.actor, action: 'payment.salesforce_push', targetType: 'account', targetId: accountId, targetAccountId: accountId, outcome, reason: why, ip: ctx.ip, metadata: { paymentIntentId, ...metadata } },
			undefined,
			{ bestEffort: true }
		);
	try {
		let message: string;
		if (row.kind === 'balance') message = await pushBalance(accountId, paymentIntentId, row.sfdc_payment_id);
		else if (row.kind === 'renewal') message = await pushRenewal(accountId, paymentIntentId, row);
		else if (row.kind === 'other') throw new ActionError('This payment is not tied to a Salesforce payment type. Record it in Salesforce directly.', 422);
		else throw new ActionError('Purchases are sent with their contract: use "Create in Salesforce" or "Complete missing records" on the Contracts tab.', 422);
		await audit('success', { message });
		return message;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await audit('failure', { error: msg });
		if (e instanceof ActionError) throw e;
		await logError({ source: 'admin.stripe_import', operation: 'push_payment', accountId, errorMessage: msg, context: { paymentIntentId } });
		throw new ActionError(`Salesforce could not be updated: ${msg}`, 502);
	}
}

/** Mark the existing Salesforce payment record paid (same path as the checkout return page). */
async function pushBalance(accountId: string, paymentIntentId: string, sfPaymentId: string | null): Promise<string> {
	if (!sfPaymentId || !(await getOwnedPayment(accountId, sfPaymentId))) {
		throw new ActionError('The Salesforce payment record was not found on this account.', 404);
	}
	const pi = await getStripe().paymentIntents.retrieve(paymentIntentId);
	if (pi.metadata?.payment_id !== sfPaymentId) throw new ActionError('Stripe links this payment to a different Salesforce record.', 409);
	const result = await applyBalancePaid(pi);
	const [after] = await sql<{ sf_status: string }[]>`SELECT sf_status FROM stripe_payments WHERE stripe_payment_intent_id = ${paymentIntentId}`;
	if (result === 'applied' || after?.sf_status === 'applied') return 'Salesforce payment marked Paid.';
	if (result === 'mismatch') throw new ActionError('The amount differs from the Salesforce payment record, so nothing was changed.', 409);
	if (after?.sf_status === 'already_paid') throw new ActionError('Salesforce shows this record paid by another transaction — check for a double charge.', 409);
	throw new ActionError('This payment is marked as being applied already, but Salesforce does not show it. Check the logs.', 409);
}

/** Create the renewal's payment record, unless Salesforce already has one for this transaction. */
async function pushRenewal(
	accountId: string,
	paymentIntentId: string,
	row: { service_contract_id: string | null; amount_cents: string; currency: string; paid_at: Date }
): Promise<string> {
	const [contract] = await sql<{ sfdc_service_contract_id: string | null }[]>`
		SELECT sfdc_service_contract_id FROM service_contracts WHERE id = ${row.service_contract_id} AND account_id = ${accountId}`;
	const sfContractId = contract?.sfdc_service_contract_id;
	if (!sfContractId) throw new ActionError('The subscription contract is not in Salesforce. Create it there first.', 409);
	if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntentId)) throw new ActionError('Invalid payment reference.', 422);

	// One push at a time per transaction, so two clicks cannot create two records.
	return sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtext(${paymentIntentId}))`;
		let sfId = (await sfdcQuery<{ Id: string }>(`SELECT Id FROM Payment__c WHERE Stripe_Payment_Intent_Id__c = '${paymentIntentId}' LIMIT 1`)).records[0]?.Id;
		const existed = !!sfId;
		if (!sfId) {
			const created = await createPayment(
				{
					amount: Number(row.amount_cents) / 100, currency: row.currency, description: 'Subscription renewal',
					paymentType: 'Subscription Renewal', status: 'Paid', paidAt: row.paid_at,
					stripe: { paymentIntentId }, sfdcServiceContractId: sfContractId
				},
				{ accountId }
			);
			if (!created.ok) throw new ActionError(`Salesforce rejected the payment: ${created.error}`, 502);
			sfId = created.id;
		}
		await tx`
			UPDATE stripe_payments SET sfdc_payment_id = ${sfId}, sfdc_service_contract_id = ${sfContractId}, sf_status = 'applied', sf_error = NULL
			WHERE stripe_payment_intent_id = ${paymentIntentId}`;
		return existed ? 'Salesforce already had this payment — linked.' : 'Renewal payment created in Salesforce.';
	}) as Promise<string>;
}
