/**
 * Turns a collected checkout payment into the local contract and its Salesforce records.
 *
 * Run by BOTH /checkout/success and the Stripe webhook, so a customer who is charged but never reaches the
 * success page still gets a contract. Two entry points:
 *   - PaymentIntent (embedded Payment Element: one-off service, recurring term, one-off subscription)
 *   - Checkout Session in `mode: 'subscription'` (recurring Stripe Subscription)
 *
 * Idempotency: the `service_contracts` insert is the claim. `stripe_payment_intent_id` (and
 * `stripe_subscription_id`) are unique, and the insert uses ON CONFLICT DO NOTHING, so of any number of
 * concurrent callers exactly one gets a new row, and only that one writes to Salesforce. Everyone else
 * reports the existing row's state and does nothing.
 *
 * Retries: `retry: true` (or a thrown error) means nothing was stored and running again may succeed — the
 * webhook turns that into a failed delivery so Stripe sends the event again. Once the row exists, a
 * Salesforce failure is recorded on it (`sync_status = 'failed'`) and is NOT retried automatically, because
 * creating a ServiceContract is not safe to repeat; staff use the admin "Create in Salesforce" / repair actions.
 */
import type Stripe from 'stripe';
import { getStripe } from '$lib/server/stripe';
import { sql } from '$lib/server/db';
import {
	getCatalogProduct,
	parseRecurringOptions,
	balanceLater,
	createServiceContractWithLines,
	buildRecurringLines,
	cancelServiceContract,
	setAccountActiveServiceContract,
	setStoreActiveServiceContract,
	getWhiteGloveStoreRecordTypeId,
	updateStoreRecordType,
	type CatalogProduct
} from '$lib/server/salesforce';
import { logError, describeError } from '$lib/server/error_log';

const SERVICE_TERM_MONTHS = 3;
const SUBSCRIPTION_TERM_MONTHS = 12;
const SOURCE = 'checkout.fulfillment';

export interface FulfillmentResult {
	localContractId: string | null;
	/** 'pending': the contract is stored and another caller is (or was) still writing it to Salesforce. */
	syncStatus: 'synced' | 'pending' | 'failed';
	syncError?: string;
	/** Nothing was stored and a later attempt may succeed. */
	retry?: boolean;
}

const failed = (syncError: string, retry = false): FulfillmentResult => ({ localContractId: null, syncStatus: 'failed', syncError, retry });

// ─── Shared helpers ────────────────────────────────────────────────────────

/** The contract already stored for this purchase, as a result — or null when there is none. */
async function existingContract(paymentKey: string, subscriptionId: string | null = null): Promise<FulfillmentResult | null> {
	const [row] = await sql<{ id: string; sync_status: FulfillmentResult['syncStatus']; sync_error: string | null }[]>`
		SELECT id, sync_status, sync_error FROM service_contracts
		WHERE stripe_payment_intent_id = ${paymentKey} OR stripe_subscription_id = ${subscriptionId}
		LIMIT 1
	`;
	if (!row) return null;
	return { localContractId: row.id, syncStatus: row.sync_status, ...(row.sync_error ? { syncError: row.sync_error } : {}) };
}

async function markSyncFailed(contractId: string, error: string): Promise<FulfillmentResult> {
	await sql`
		UPDATE service_contracts SET sync_status = 'failed', sync_error = ${error}
		WHERE id = ${contractId}
	`;
	return { localContractId: contractId, syncStatus: 'failed', syncError: error };
}

/**
 * Everything after the claim. An unexpected error must not leave the row 'pending' for good: no later caller
 * will redo this work, so it is recorded as a failed sync for staff to repair.
 */
async function afterClaim(
	contractId: string,
	ids: { userId: string; accountId: string; paymentKey: string },
	run: () => Promise<FulfillmentResult>
): Promise<FulfillmentResult> {
	try {
		return await run();
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: SOURCE, operation: 'sync_contract', userId: ids.userId, accountId: ids.accountId,
			errorMessage: desc.errorMessage, stack: desc.stack, context: { paymentKey: ids.paymentKey, contractId }
		});
		const [row] = await sql<{ sync_status: string }[]>`SELECT sync_status FROM service_contracts WHERE id = ${contractId}`;
		// Already in Salesforce: only a follow-up step (e.g. pointing stores at a subscription) failed.
		if (row?.sync_status === 'synced') return { localContractId: contractId, syncStatus: 'synced' };
		return markSyncFailed(contractId, desc.errorMessage);
	}
}

/**
 * Subscriptions are account-level: one active plan covers every store.
 * Returns the account's current active subscription contract (to be replaced).
 */
async function previousAccountSubscription(accountId: string) {
	const [row] = await sql<{ id: string; sfdc_service_contract_id: string | null; paid_at: Date }[]>`
		SELECT sc.id, sc.sfdc_service_contract_id, sc.paid_at
		FROM accounts a JOIN service_contracts sc ON sc.id = a.active_subscription_contract_id
		WHERE a.id = ${accountId} AND sc.kind = 'subscription' AND sc.status = 'active'
	`;
	return row ?? null;
}

/**
 * A purchase stored late (a webhook retried hours afterwards) must not cancel a plan bought after it.
 * Logged so staff can sort out the two plans.
 */
async function isSuperseded(
	prev: { id: string; paid_at: Date } | null,
	paidAt: Date,
	ids: { userId: string; accountId: string; paymentKey: string }
): Promise<boolean> {
	if (!prev || prev.paid_at.getTime() <= paidAt.getTime()) return false;
	await logError({
		source: SOURCE, operation: 'superseded_subscription', severity: 'warn', userId: ids.userId, accountId: ids.accountId,
		errorMessage: 'A subscription paid earlier was stored after a newer one; the newer plan stays active. Check both in Stripe.',
		context: { paymentKey: ids.paymentKey, activeContractId: prev.id }
	});
	return true;
}

/**
 * Point the account at its new subscription and mirror it onto every store's
 * Salesforce Store__c (Service_Contract__c + the "White_Glove" record type).
 * Best-effort in Salesforce — failures are logged, never fail the purchase.
 */
async function activateAccountSubscription(
	accountId: string,
	userId: string | null,
	localContractId: string,
	sfdcServiceContractId: string
): Promise<void> {
	await sql`UPDATE accounts SET active_subscription_contract_id = ${localContractId} WHERE id = ${accountId}`;
	const [acct] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	if (acct?.sfdc_account_id) {
		await setAccountActiveServiceContract(acct.sfdc_account_id, sfdcServiceContractId, {
			userId: userId ?? undefined,
			accountId
		});
	}
	const stores = await sql<{ sfdc_store_id: string | null }[]>`
		SELECT sfdc_store_id FROM stores WHERE account_id = ${accountId} AND sfdc_store_id IS NOT NULL
	`;
	if (!stores.length) return;
	const whiteGloveRecordTypeId = await getWhiteGloveStoreRecordTypeId();
	for (const st of stores) {
		await setStoreActiveServiceContract(st.sfdc_store_id!, sfdcServiceContractId, {
			userId: userId ?? undefined,
			accountId
		});
		if (whiteGloveRecordTypeId) {
			await updateStoreRecordType(st.sfdc_store_id!, whiteGloveRecordTypeId, {
				userId: userId ?? undefined,
				accountId
			});
		}
	}
}

// ─── PaymentIntent flow ────────────────────────────────────────────────────

export interface PaymentSnapshot {
	pi: Stripe.PaymentIntent;
	products: CatalogProduct[];
	kind: 'service' | 'subscription' | 'recurring';
	/** When the first payment was actually received (charge time) — becomes the contract StartDate. */
	paymentReceivedAt: Date;
	/** Recurring only: the term the customer picked (months) → ServiceContract.Term. */
	recurringTermMonths: number | null;
	/** Recurring only: pay in full (whole term charged now) or by month (first month now, one payment per later month). */
	recurringPayOption: 'full' | 'monthly' | null;
}

/**
 * Was this PaymentIntent created by the app's checkout? Balance payments (handled by payments/balance.ts) and
 * the PaymentIntents Stripe creates for subscription invoices are not.
 */
export function isCheckoutPaymentIntent(pi: Stripe.PaymentIntent): boolean {
	return pi.metadata?.kind !== 'balance' && !!pi.metadata?.pricebook_entry_ids && !!pi.metadata.user_id;
}

export async function snapshotPaymentIntent(piId: string): Promise<PaymentSnapshot> {
	const pi = await getStripe().paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
	const kind: 'service' | 'subscription' | 'recurring' =
		pi.metadata?.kind === 'subscription' ? 'subscription' : pi.metadata?.kind === 'recurring' ? 'recurring' : 'service';
	// Term / payment option were set server-side when the PaymentIntent was created.
	const recurring = kind === 'recurring' ? parseRecurringOptions(pi.metadata?.term_months, pi.metadata?.pay_option) : null;
	const entryIds = (pi.metadata?.pricebook_entry_ids ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
	const products: CatalogProduct[] = [];
	for (const id of entryIds) {
		const p = await getCatalogProduct(id, kind, recurring);
		if (p) products.push(p);
	}
	const charge = typeof pi.latest_charge === 'object' && pi.latest_charge ? pi.latest_charge : null;
	return { pi, products, kind, paymentReceivedAt: new Date((charge?.created ?? pi.created) * 1000), recurringTermMonths: recurring?.termMonths ?? null, recurringPayOption: recurring?.payOption ?? null };
}

/**
 * Insert the contract + line items + push to Salesforce for a SUCCEEDED PaymentIntent.
 * Safe to call any number of times, concurrently.
 */
export async function persistContract(snapshot: PaymentSnapshot, fallbackUserId: string | null = null): Promise<FulfillmentResult> {
	const { pi, products, kind } = snapshot;
	if (pi.status !== 'succeeded') return failed('Payment has not succeeded.');
	if (pi.metadata?.kind === 'balance') return failed('Balance payments do not create a contract.');
	const termMonths =
		kind === 'subscription'
			? SUBSCRIPTION_TERM_MONTHS
			: kind === 'recurring'
				? (snapshot.recurringTermMonths ?? 0)
				: SERVICE_TERM_MONTHS;
	if (kind === 'recurring' && termMonths < 1) {
		await logError({ source: SOURCE, operation: 'persist_contract', errorMessage: 'Missing recurring term.', context: { paymentIntentId: pi.id } });
		return failed('Missing recurring term.');
	}
	const already = await existingContract(pi.id);
	if (already) return already;

	const userId = pi.metadata?.user_id || fallbackUserId;
	if (!userId) {
		await logError({
			source: SOURCE,
			operation: 'persist_contract',
			errorMessage: 'No user_id available — cannot persist contract.',
			context: { paymentIntentId: pi.id }
		});
		return failed('Missing user_id.');
	}

	const [user] = await sql<{ account_id: string | null; sfdc_contact_id: string | null }[]>`
		SELECT account_id, sfdc_contact_id FROM users WHERE id = ${userId} LIMIT 1
	`;
	if (!user?.account_id) {
		await logError({ source: SOURCE, operation: 'persist_contract', errorMessage: 'User has no account.', context: { paymentIntentId: pi.id, userId } });
		return failed('User has no account.');
	}

	// An empty catalog usually means Salesforce could not be read. Storing a contract without its lines would
	// claim the payment for good, so store nothing and try again later.
	if (!products.length) {
		await logError({
			source: SOURCE, operation: 'persist_contract', userId, accountId: user.account_id,
			errorMessage: 'None of the purchased products could be loaded from the Salesforce price book.',
			context: { paymentIntentId: pi.id, pricebookEntryIds: pi.metadata?.pricebook_entry_ids }
		});
		return failed('The purchased services could not be loaded.', true);
	}

	const [account] = await sql<{ sfdc_account_id: string | null }[]>`
		SELECT sfdc_account_id FROM accounts WHERE id = ${user.account_id} LIMIT 1
	`;

	interface StoreRow {
		id: string;
		name: string;
		sfdc_store_id: string | null;
		poc_sfdc_contact_id: string | null;
		active_service_contract_id: string | null;
		active_sfdc_service_contract_id: string | null;
	}
	let storeRow: StoreRow | null = null;
	const metaStoreId = pi.metadata?.store_id?.trim();
	if (metaStoreId) {
		const rows = await sql<StoreRow[]>`
			SELECT s.id, s.name, s.sfdc_store_id, s.active_service_contract_id,
			       ac.sfdc_contact_id AS poc_sfdc_contact_id,
			       active.sfdc_service_contract_id AS active_sfdc_service_contract_id
			FROM stores s
			LEFT JOIN account_contacts ac ON ac.id = s.point_of_contact_id
			LEFT JOIN service_contracts active ON active.id = s.active_service_contract_id
			WHERE s.id = ${metaStoreId} AND s.account_id = ${user.account_id}
			LIMIT 1
		`;
		storeRow = rows[0] ?? null;
	}

	const paidAt = snapshot.paymentReceivedAt;
	const startDate = paidAt;                                                  // StartDate = when the first payment was received
	const endDate = new Date(paidAt.getTime());
	endDate.setUTCMonth(endDate.getUTCMonth() + termMonths);

	// Recurring: one ContractLineItem per month of the term (Quantity = units bought, UnitPrice = monthly price).
	// Pay by month: month 1 is paid by this charge, the others are future payments; pay in full: all 6 lines, one payment.
	let sfLines: Parameters<typeof createServiceContractWithLines>[0]['lineItems'] | null = null;
	if (kind === 'recurring') {
		const groups = new Map<string, { pricebookEntryId: string; name: string; quantity: number; monthlyPrice: number }>();
		for (const p of products) {
			const g = groups.get(p.pricebookEntryId);
			if (g) g.quantity += 1;
			else groups.set(p.pricebookEntryId, { pricebookEntryId: p.pricebookEntryId, name: p.name, quantity: 1, monthlyPrice: p.monthlyPrice ?? p.unitPrice });
		}
		sfLines = buildRecurringLines([...groups.values()], termMonths, startDate, snapshot.recurringPayOption ?? 'full');
	}

	const feeCents = Number(pi.metadata?.fee_cents) || 0;
	const amountCents = pi.amount - feeCents; // contract value excludes the pass-through Stripe fee
	const currency = (pi.currency || 'usd').toUpperCase();
	const chargeId = typeof pi.latest_charge === 'string' ? pi.latest_charge : (pi.latest_charge?.id ?? null);
	const paymentMethodId = typeof pi.payment_method === 'string' ? pi.payment_method : null;
	const paymentMethodType = pi.payment_method_types?.[0] ?? null;
	const pricebook2Id = products[0]?.pricebook2Id ?? null;

	// ── 1. Claim the payment: insert local contract + line items in one transaction ──
	let localContractId: string | null;
	try {
		localContractId = await sql.begin(async (sql) => {
			const [contract] = await sql<{ id: string }[]>`
				INSERT INTO service_contracts (
					account_id, user_id, store_id,
					stripe_payment_intent_id, stripe_charge_id,
					stripe_payment_method_id, stripe_payment_method_type,
					stripe_receipt_email,
					amount_cents, currency, paid_at,
					start_date, end_date, term_months, kind, payment_status,
					sfdc_account_id, sfdc_contact_id, sfdc_store_id, sfdc_pricebook2_id
				) VALUES (
					${user.account_id}, ${userId}, ${storeRow?.id ?? null},
					${pi.id}, ${chargeId},
					${paymentMethodId}, ${paymentMethodType},
					${pi.receipt_email ?? null},
					${amountCents}, ${currency}, ${paidAt},
					${startDate.toISOString().slice(0, 10)},
					${endDate.toISOString().slice(0, 10)},
					${termMonths}, ${kind}, ${kind === 'subscription' ? 'Subscription' : 'Paid'},
					${account?.sfdc_account_id ?? null},
					${user.sfdc_contact_id ?? null},
					${storeRow?.sfdc_store_id ?? null},
					${pricebook2Id}
				)
				ON CONFLICT (stripe_payment_intent_id) DO NOTHING
				RETURNING id
			`;
			if (!contract) return null; // another caller got there first
			if (sfLines) {
				// Recurring: mirror the per-month Salesforce lines (seq keeps the same order for the SF id mapping).
				for (let i = 0; i < sfLines.length; i++) {
					const l = sfLines[i];
					const p = products.find((x) => x.pricebookEntryId === l.pricebookEntryId)!;
					await sql`
						INSERT INTO service_contract_line_items (
							service_contract_id, product_name, product_description,
							product_category, sfdc_product_id, sfdc_pricebook_entry_id,
							unit_price, quantity, currency, balance_due, seq, month_index, payment_due_date
						) VALUES (
							${contract.id}, ${l.name}, ${l.description ?? p.description},
							${p.category}, ${p.productId}, ${l.pricebookEntryId},
							${l.unitPrice}, ${l.quantity}, ${p.currency},
							${l.installment?.status === 'due' ? Math.round(l.unitPrice * l.quantity * 100) / 100 : 0},
							${i}, ${l.monthIndex ?? null}, ${l.installment ? l.installment.dueDate.toISOString().slice(0, 10) : null}
						)
					`;
				}
				return contract.id;
			}
			for (const [i, p] of products.entries()) {
				await sql`
					INSERT INTO service_contract_line_items (
						service_contract_id, product_name, product_description,
						product_category, sfdc_product_id, sfdc_pricebook_entry_id,
						unit_price, quantity, currency, balance_due, seq
					) VALUES (
						${contract.id}, ${p.name}, ${p.description},
						${p.category}, ${p.productId}, ${p.pricebookEntryId},
						${p.monthlyPrice ?? p.unitPrice}, ${p.termMonths ?? 1}, ${p.currency}, ${balanceLater(p)}, ${i}
					)
				`;
			}
			return contract.id;
		});
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: SOURCE,
			operation: 'insert_local_contract',
			userId,
			accountId: user.account_id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { paymentIntentId: pi.id }
		});
		return failed(desc.errorMessage, true);
	}
	if (!localContractId) return (await existingContract(pi.id)) ?? failed('The contract could not be stored.', true);

	// ── 2. Push to Salesforce (only the caller that inserted the row) ──
	const contractId = localContractId;
	const accountId = user.account_id;
	const ids = { userId, accountId, paymentKey: pi.id };
	return afterClaim(contractId, ids, async () => {
		if (!account?.sfdc_account_id || !pricebook2Id) {
			return markSyncFailed(contractId, !account?.sfdc_account_id ? 'Account not linked to Salesforce.' : 'No SF pricebook id.');
		}

		// ── 2b. Subscription upgrade: cancel the ACCOUNT's previous active subscription ──
		//    Best-effort — a cancel failure shouldn't block the new subscription
		//    from being created; it's logged inside cancelServiceContract().
		let superseded = false;
		if (kind === 'subscription') {
			const prev = await previousAccountSubscription(accountId);
			superseded = await isSuperseded(prev, paidAt, ids);
			if (prev && !superseded) {
				if (prev.sfdc_service_contract_id) {
					await cancelServiceContract(prev.sfdc_service_contract_id, { userId, accountId });
				}
				await sql`UPDATE service_contracts SET status = 'cancelled' WHERE id = ${prev.id}`;
			}
		}

		// Name = "<Store Name> <YYYY-MM-DD> Services|Subscription" — e.g. "Amazon US 2026-06-06 Services".
		const purchaseDateStr = startDate.toISOString().slice(0, 10);
		const namePrefix = storeRow?.name?.trim() || 'Untitled Store';
		const contractName = `${namePrefix} ${purchaseDateStr} ${kind === 'subscription' ? 'Subscription' : kind === 'recurring' ? 'Recurring Services' : 'Services'}`;

		const sfResult = await createServiceContractWithLines(
			{
				name: contractName,
				kind,
				sfdcAccountId: account.sfdc_account_id,
				sfdcContactId: user.sfdc_contact_id,
				sfdcStoreId: storeRow?.sfdc_store_id ?? null,
				sfdcPricebook2Id: pricebook2Id,
				startDate,
				termMonths,
				stripe: {
					paymentIntentId: pi.id,
					chargeId,
					amount: amountCents / 100,
					currency,
					receiptEmail: pi.receipt_email ?? null,
					paymentMethodId,
					paymentMethodType
				},
				lineItems: sfLines ?? products.map((p) => ({
					pricebookEntryId: p.pricebookEntryId,
					quantity: p.termMonths ?? 1,
					unitPrice: p.monthlyPrice ?? p.unitPrice,
					name: p.name,
					balanceDue: balanceLater(p)
				})),
				sfdcStoreContactId: storeRow?.poc_sfdc_contact_id ?? null,
				localContractId: contractId,
				paymentStatus: kind === 'subscription' ? 'Subscription' : 'Paid'
			},
			{ userId, accountId }
		);

		if (!sfResult.ok) return markSyncFailed(contractId, sfResult.error);

		await sql.begin(async (sql) => {
			await sql`
				UPDATE service_contracts SET
					sfdc_service_contract_id = ${sfResult.sfdcServiceContractId},
					sync_status = 'synced',
					sync_error = NULL,
					synced_at = now()
				WHERE id = ${contractId}
			`;
			const lineRows = await sql<{ id: string }[]>`
				SELECT id FROM service_contract_line_items
				WHERE service_contract_id = ${contractId}
				ORDER BY seq ASC NULLS LAST, created_at ASC
			`;
			for (let i = 0; i < lineRows.length; i++) {
				const sfLineId = sfResult.lineItemIds[i];
				if (sfLineId) {
					await sql`
						UPDATE service_contract_line_items
						SET sfdc_contract_line_item_id = ${sfLineId}
						WHERE id = ${lineRows[i].id}
					`;
				}
			}
		});

		// ── 3. Subscription: point the account (and every store in Salesforce) at the new contract ──
		if (kind === 'subscription' && !superseded) {
			await activateAccountSubscription(accountId, userId, contractId, sfResult.sfdcServiceContractId);
		}

		return { localContractId: contractId, syncStatus: 'synced' };
	});
}

/** Webhook entry point: persist a succeeded checkout PaymentIntent. Other PaymentIntents are ignored (null). */
export async function fulfillPaymentIntent(pi: Stripe.PaymentIntent): Promise<FulfillmentResult | null> {
	if (!isCheckoutPaymentIntent(pi) || pi.status !== 'succeeded') return null;
	// Usually the success page has been here already: skip the Stripe and Salesforce reads.
	const already = await existingContract(pi.id);
	if (already) return already;
	// Read it again: the event carries only the charge id, and the contract starts at the charge time.
	return persistContract(await snapshotPaymentIntent(pi.id));
}

// ─── Checkout Session subscription flow ────────────────────────────────────

/**
 * Idempotently persist a recurring Stripe Subscription created via
 * /api/checkout/subscription (Checkout Session, mode: 'subscription') —
 * one local service_contracts row + one Salesforce ServiceContract, exactly
 * like a one-off service purchase but with kind='subscription',
 * payment_status='Subscription', and a stripe_subscription_id for the
 * webhook to find later on cancellation.
 *
 * Returns null for a session that is not a paid subscription checkout.
 * `paidAt` is when the payment happened (the webhook passes the event time).
 */
export async function persistSubscriptionContract(
	session: Stripe.Checkout.Session,
	opts: { fallbackUserId?: string | null; paidAt?: Date } = {}
): Promise<FulfillmentResult | null> {
	if (session.payment_status !== 'paid' || session.metadata?.kind !== 'subscription') return null;
	const subscriptionId =
		typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null);
	if (!subscriptionId) return null;
	const paymentKey = `checkout_session:${session.id}`;

	const already = await existingContract(paymentKey, subscriptionId);
	if (already) return already;

	const meta = session.metadata ?? {};
	const userId = meta.user_id || opts.fallbackUserId || null;
	const accountId = meta.account_id || null;
	const pricebookEntryId = meta.pricebook_entry_id;
	if (!userId || !accountId || !pricebookEntryId) {
		await logError({
			source: SOURCE,
			operation: 'persist_subscription',
			errorMessage: 'Checkout Session is missing required metadata for subscription fulfillment.',
			context: { sessionId: session.id }
		});
		return failed('Missing session metadata.');
	}

	const [acct] = await sql<{ name: string; sfdc_account_id: string | null }[]>`
		SELECT name, sfdc_account_id FROM accounts WHERE id = ${accountId} LIMIT 1
	`;
	if (!acct) {
		await logError({ source: SOURCE, operation: 'persist_subscription', errorMessage: 'The account on the Checkout Session does not exist.', context: { sessionId: session.id, accountId } });
		return failed('Account not found.');
	}

	const product = await getCatalogProduct(pricebookEntryId, 'subscription');
	if (!product) {
		await logError({
			source: SOURCE, operation: 'persist_subscription', userId, accountId,
			errorMessage: 'The purchased plan could not be loaded from the Salesforce price book.',
			context: { sessionId: session.id, subscriptionId, pricebookEntryId }
		});
		return failed('Plan no longer in catalog.', true);
	}

	const [user] = await sql<{ sfdc_contact_id: string | null }[]>`
		SELECT sfdc_contact_id FROM users WHERE id = ${userId} LIMIT 1
	`;

	const paidAt = opts.paidAt ?? new Date();
	const startDate = paidAt;
	const endDate = new Date(paidAt.getTime());
	endDate.setUTCMonth(endDate.getUTCMonth() + SUBSCRIPTION_TERM_MONTHS);
	const amountCents = session.amount_total ?? Math.round(product.unitPrice * 100);
	const currency = (session.currency || 'usd').toUpperCase();

	let localContractId: string | null;
	try {
		localContractId = await sql.begin(async (sql) => {
			// No conflict target: either unique key (payment key or subscription id) means "already stored".
			const [contract] = await sql<{ id: string }[]>`
				INSERT INTO service_contracts (
					account_id, user_id, store_id,
					stripe_payment_intent_id, stripe_subscription_id,
					stripe_receipt_email,
					amount_cents, currency, paid_at,
					start_date, end_date, term_months, kind, payment_status,
					sfdc_account_id, sfdc_contact_id, sfdc_store_id, sfdc_pricebook2_id
				) VALUES (
					${accountId}, ${userId}, NULL,
					${paymentKey}, ${subscriptionId},
					${session.customer_details?.email ?? null},
					${amountCents}, ${currency}, ${paidAt},
					${startDate.toISOString().slice(0, 10)},
					${endDate.toISOString().slice(0, 10)},
					${SUBSCRIPTION_TERM_MONTHS}, 'subscription', 'Subscription',
					${acct.sfdc_account_id ?? null},
					${user?.sfdc_contact_id ?? null},
					NULL,
					${product.pricebook2Id}
				)
				ON CONFLICT DO NOTHING
				RETURNING id
			`;
			if (!contract) return null;
			await sql`
				INSERT INTO service_contract_line_items (
					service_contract_id, product_name, product_description,
					product_category, sfdc_product_id, sfdc_pricebook_entry_id,
					unit_price, quantity, currency
				) VALUES (
					${contract.id}, ${product.name}, ${product.description},
					${product.category}, ${product.productId}, ${product.pricebookEntryId},
					${product.unitPrice}, 1, ${product.currency}
				)
			`;
			return contract.id;
		});
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: SOURCE,
			operation: 'insert_local_subscription',
			userId,
			accountId,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { sessionId: session.id, subscriptionId }
		});
		return failed(desc.errorMessage, true);
	}
	if (!localContractId) return (await existingContract(paymentKey, subscriptionId)) ?? failed('The contract could not be stored.', true);

	const contractId = localContractId;
	const ids = { userId, accountId, paymentKey };
	return afterClaim(contractId, ids, async () => {
		// Activate locally right away (even if Salesforce sync fails below) so the
		// customer's paid plan is honoured everywhere in the app immediately.
		const current = await previousAccountSubscription(accountId);
		const superseded = await isSuperseded(current, paidAt, ids);
		const prev = superseded ? null : current; // the plan this one replaces
		if (!superseded) {
			if (prev) {
				await sql`
					UPDATE service_contracts SET status = 'cancelled', payment_status = 'Canceled'
					WHERE id = ${prev.id} AND id <> ${contractId}
				`;
			}
			await sql`UPDATE accounts SET active_subscription_contract_id = ${contractId} WHERE id = ${accountId}`;
		}

		if (!acct.sfdc_account_id) return markSyncFailed(contractId, 'Account not linked to Salesforce.');

		if (prev?.sfdc_service_contract_id) {
			await cancelServiceContract(prev.sfdc_service_contract_id, { userId, accountId });
		}

		const purchaseDateStr = startDate.toISOString().slice(0, 10);
		const namePrefix = acct.name?.trim() || 'Account';
		const contractName = `${namePrefix} ${purchaseDateStr} Subscription`;

		const sfResult = await createServiceContractWithLines(
			{
				name: contractName,
				kind: 'subscription',
				sfdcAccountId: acct.sfdc_account_id,
				sfdcContactId: user?.sfdc_contact_id ?? null,
				sfdcStoreId: null,
				sfdcPricebook2Id: product.pricebook2Id,
				startDate,
				termMonths: SUBSCRIPTION_TERM_MONTHS,
				stripe: {
					paymentIntentId: paymentKey,
					chargeId: null,
					amount: amountCents / 100,
					currency,
					receiptEmail: session.customer_details?.email ?? null,
					paymentMethodId: null,
					paymentMethodType: null
				},
				lineItems: [
					{
						pricebookEntryId: product.pricebookEntryId,
						quantity: 1,
						unitPrice: product.unitPrice,
						name: product.name
					}
				],
				sfdcStoreContactId: null,
				localContractId: contractId,
				paymentStatus: 'Subscription'
			},
			{ userId, accountId }
		);

		if (!sfResult.ok) return markSyncFailed(contractId, sfResult.error);

		await sql`
			UPDATE service_contracts SET
				sfdc_service_contract_id = ${sfResult.sfdcServiceContractId},
				sync_status = 'synced', sync_error = NULL, synced_at = now()
			WHERE id = ${contractId}
		`;

		if (!superseded) await activateAccountSubscription(accountId, userId, contractId, sfResult.sfdcServiceContractId);

		return { localContractId: contractId, syncStatus: 'synced' };
	});
}
