/**
 * Stripe success landing.
 *
 *  - New flow (embedded Payment Element): Stripe redirects here with
 *      ?payment_intent=pi_…&payment_intent_client_secret=…&redirect_status=succeeded
 *    We retrieve the PaymentIntent via Stripe, then idempotently create a
 *    local service_contracts row (UPSERT by stripe_payment_intent_id) and
 *    push it to Salesforce as a ServiceContract + ContractLineItems.
 *
 *  - Old flow (hosted Checkout Session): query was `?session_id=cs_…`. Still
 *    handled below for stale redirects.
 *
 * Idempotency: every action below keys on stripe_payment_intent_id. Hitting
 * refresh on this page will not double-create anything.
 */
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
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

interface PaymentSnapshot {
	pi: import('stripe').Stripe.PaymentIntent;
	products: CatalogProduct[];
	kind: 'service' | 'subscription' | 'recurring';
	/** When the first payment was actually received (charge time) — becomes the contract StartDate. */
	paymentReceivedAt: Date;
	/** Recurring only: the term the customer picked (months) → ServiceContract.Term. */
	recurringTermMonths: number | null;
	/** Recurring only: pay in full (whole term charged now) or by month (first month now, one payment per later month). */
	recurringPayOption: 'full' | 'monthly' | null;
}

async function snapshotPaymentIntent(piId: string): Promise<PaymentSnapshot> {
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
 * Returns true if a contract for this PaymentIntent has already been
 * inserted into our local DB.
 */
async function hasLocalContract(piId: string): Promise<boolean> {
	const rows = await sql<{ id: string }[]>`
		SELECT id FROM service_contracts
		WHERE stripe_payment_intent_id = ${piId} LIMIT 1
	`;
	return rows.length > 0;
}

/**
 * Insert the contract + line items + push to Salesforce.
 * Safe to call multiple times — guarded by `hasLocalContract`.
 */
async function persistContract(
	snapshot: PaymentSnapshot,
	locals: App.Locals
): Promise<{ localContractId: string | null; syncStatus: string; syncError?: string }> {
	const { pi, products, kind } = snapshot;
	const termMonths =
		kind === 'subscription'
			? SUBSCRIPTION_TERM_MONTHS
			: kind === 'recurring'
				? (snapshot.recurringTermMonths ?? 0)
				: SERVICE_TERM_MONTHS;
	if (kind === 'recurring' && termMonths < 1) {
		return { localContractId: null, syncStatus: 'failed', syncError: 'Missing recurring term.' };
	}
	if (await hasLocalContract(pi.id)) {
		return { localContractId: null, syncStatus: 'already-exists' };
	}

	const userId = pi.metadata?.user_id || locals.user?.id || null;
	if (!userId) {
		await logError({
			source: 'checkout.success',
			operation: 'persist_contract',
			errorMessage: 'No user_id available — cannot persist contract.',
			context: { paymentIntentId: pi.id }
		});
		return { localContractId: null, syncStatus: 'failed', syncError: 'Missing user_id.' };
	}

	const [user] = await sql<{ account_id: string | null; sfdc_contact_id: string | null }[]>`
		SELECT account_id, sfdc_contact_id FROM users WHERE id = ${userId} LIMIT 1
	`;
	if (!user?.account_id) {
		return { localContractId: null, syncStatus: 'failed', syncError: 'User has no account.' };
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

	// ── 1. Insert local contract + line items in one transaction ──
	let localContractId: string;
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
				RETURNING id
			`;
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
			source: 'checkout.success',
			operation: 'insert_local_contract',
			userId,
			accountId: user.account_id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { paymentIntentId: pi.id }
		});
		return { localContractId: null, syncStatus: 'failed', syncError: desc.errorMessage };
	}

	// ── 2. Push to Salesforce ──
	if (!account?.sfdc_account_id || !pricebook2Id) {
		const missing = !account?.sfdc_account_id ? 'Account not linked to Salesforce.' : 'No SF pricebook id.';
		await sql`
			UPDATE service_contracts SET sync_status = 'failed', sync_error = ${missing}
			WHERE id = ${localContractId}
		`;
		return { localContractId, syncStatus: 'failed', syncError: missing };
	}

	// ── 2b. Subscription upgrade: cancel the ACCOUNT's previous active subscription ──
	//    Best-effort — a cancel failure shouldn't block the new subscription
	//    from being created; it's logged inside cancelServiceContract().
	if (kind === 'subscription') {
		const prev = await previousAccountSubscription(user.account_id);
		if (prev) {
			if (prev.sfdc_service_contract_id) {
				await cancelServiceContract(prev.sfdc_service_contract_id, { userId, accountId: user.account_id });
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
			localContractId,
			paymentStatus: kind === 'subscription' ? 'Subscription' : 'Paid'
		},
		{ userId, accountId: user.account_id }
	);

	if (!sfResult.ok) {
		await sql`
			UPDATE service_contracts
			SET sync_status = 'failed', sync_error = ${sfResult.error}
			WHERE id = ${localContractId}
		`;
		return { localContractId, syncStatus: 'failed', syncError: sfResult.error };
	}

	await sql.begin(async (sql) => {
		await sql`
			UPDATE service_contracts SET
				sfdc_service_contract_id = ${sfResult.sfdcServiceContractId},
				sync_status = 'synced',
				sync_error = NULL,
				synced_at = now()
			WHERE id = ${localContractId}
		`;
		const lineRows = await sql<{ id: string }[]>`
			SELECT id FROM service_contract_line_items
			WHERE service_contract_id = ${localContractId}
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
	if (kind === 'subscription') {
		await activateAccountSubscription(user.account_id, userId, localContractId, sfResult.sfdcServiceContractId);
	}

	return { localContractId, syncStatus: 'synced' };
}

/**
 * Subscriptions are account-level: one active plan covers every store.
 * Returns the account's current active subscription contract (to be replaced).
 */
async function previousAccountSubscription(accountId: string) {
	const [row] = await sql<{ id: string; sfdc_service_contract_id: string | null }[]>`
		SELECT sc.id, sc.sfdc_service_contract_id
		FROM accounts a JOIN service_contracts sc ON sc.id = a.active_subscription_contract_id
		WHERE a.id = ${accountId} AND sc.kind = 'subscription' AND sc.status = 'active'
	`;
	return row ?? null;
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

/**
 * Idempotently persist a recurring Stripe Subscription created via
 * /api/checkout/subscription (Checkout Session, mode: 'subscription') —
 * one local service_contracts row + one Salesforce ServiceContract, exactly
 * like a one-off service purchase but with kind='subscription',
 * payment_status='Subscription', and a stripe_subscription_id for the
 * webhook to find later on cancellation.
 */
async function persistSubscriptionContract(
	session: import('stripe').Stripe.Checkout.Session,
	locals: App.Locals
): Promise<{ localContractId: string | null; syncStatus: string; syncError?: string } | null> {
	const subscriptionId =
		typeof session.subscription === 'string' ? session.subscription : (session.subscription?.id ?? null);
	if (!subscriptionId) return null;

	const existing = await sql<{ id: string }[]>`
		SELECT id FROM service_contracts WHERE stripe_subscription_id = ${subscriptionId} LIMIT 1
	`;
	if (existing.length > 0) {
		return { localContractId: existing[0].id, syncStatus: 'already-exists' };
	}

	const meta = session.metadata ?? {};
	const userId = meta.user_id || locals.user?.id || null;
	const accountId = meta.account_id || null;
	const pricebookEntryId = meta.pricebook_entry_id;
	if (!userId || !accountId || !pricebookEntryId) {
		await logError({
			source: 'checkout.success',
			operation: 'persist_subscription',
			errorMessage: 'Checkout Session is missing required metadata for subscription fulfillment.',
			context: { sessionId: session.id }
		});
		return { localContractId: null, syncStatus: 'failed', syncError: 'Missing session metadata.' };
	}

	const product = await getCatalogProduct(pricebookEntryId, 'subscription');
	if (!product) {
		return { localContractId: null, syncStatus: 'failed', syncError: 'Plan no longer in catalog.' };
	}

	const [user] = await sql<{ account_id: string | null; sfdc_contact_id: string | null }[]>`
		SELECT account_id, sfdc_contact_id FROM users WHERE id = ${userId} LIMIT 1
	`;
	const [account] = await sql<{ sfdc_account_id: string | null }[]>`
		SELECT sfdc_account_id FROM accounts WHERE id = ${accountId} LIMIT 1
	`;

	const [acct] = await sql<{ name: string }[]>`SELECT name FROM accounts WHERE id = ${accountId} LIMIT 1`;

	const paidAt = new Date();
	const startDate = paidAt;
	const endDate = new Date(paidAt.getTime());
	endDate.setUTCMonth(endDate.getUTCMonth() + SUBSCRIPTION_TERM_MONTHS);
	const amountCents = session.amount_total ?? Math.round(product.unitPrice * 100);
	const currency = (session.currency || 'usd').toUpperCase();
	const customerId = typeof session.customer === 'string' ? session.customer : (session.customer?.id ?? null);

	let localContractId: string;
	try {
		localContractId = await sql.begin(async (sql) => {
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
					${`checkout_session:${session.id}`}, ${subscriptionId},
					${session.customer_details?.email ?? null},
					${amountCents}, ${currency}, ${paidAt},
					${startDate.toISOString().slice(0, 10)},
					${endDate.toISOString().slice(0, 10)},
					${SUBSCRIPTION_TERM_MONTHS}, 'subscription', 'Subscription',
					${account?.sfdc_account_id ?? null},
					${user?.sfdc_contact_id ?? null},
					NULL,
					${product.pricebook2Id}
				)
				RETURNING id
			`;
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
			source: 'checkout.success',
			operation: 'insert_local_subscription',
			userId,
			accountId,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { sessionId: session.id, subscriptionId }
		});
		return { localContractId: null, syncStatus: 'failed', syncError: desc.errorMessage };
	}

	// Activate locally right away (even if Salesforce sync fails below) so the
	// customer's paid plan is honoured everywhere in the app immediately.
	const prev = await previousAccountSubscription(accountId);
	if (prev) {
		await sql`
			UPDATE service_contracts SET status = 'cancelled', payment_status = 'Canceled'
			WHERE id = ${prev.id} AND id <> ${localContractId}
		`;
	}
	await sql`UPDATE accounts SET active_subscription_contract_id = ${localContractId} WHERE id = ${accountId}`;

	if (!account?.sfdc_account_id) {
		await sql`
			UPDATE service_contracts SET sync_status = 'failed', sync_error = 'Account not linked to Salesforce.'
			WHERE id = ${localContractId}
		`;
		return { localContractId, syncStatus: 'failed', syncError: 'Account not linked to Salesforce.' };
	}

	if (prev?.sfdc_service_contract_id) {
		await cancelServiceContract(prev.sfdc_service_contract_id, { userId, accountId });
	}

	const purchaseDateStr = startDate.toISOString().slice(0, 10);
	const namePrefix = acct?.name?.trim() || 'Account';
	const contractName = `${namePrefix} ${purchaseDateStr} Subscription`;

	const sfResult = await createServiceContractWithLines(
		{
			name: contractName,
			kind: 'subscription',
			sfdcAccountId: account.sfdc_account_id,
			sfdcContactId: user?.sfdc_contact_id ?? null,
			sfdcStoreId: null,
			sfdcPricebook2Id: product.pricebook2Id,
			startDate,
			termMonths: SUBSCRIPTION_TERM_MONTHS,
			stripe: {
				paymentIntentId: `checkout_session:${session.id}`,
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
			localContractId,
			paymentStatus: 'Subscription'
		},
		{ userId, accountId }
	);

	if (!sfResult.ok) {
		await sql`
			UPDATE service_contracts SET sync_status = 'failed', sync_error = ${sfResult.error}
			WHERE id = ${localContractId}
		`;
		return { localContractId, syncStatus: 'failed', syncError: sfResult.error };
	}

	await sql`
		UPDATE service_contracts SET
			sfdc_service_contract_id = ${sfResult.sfdcServiceContractId},
			sync_status = 'synced', sync_error = NULL, synced_at = now()
		WHERE id = ${localContractId}
	`;

	await activateAccountSubscription(accountId, userId, localContractId, sfResult.sfdcServiceContractId);

	return { localContractId, syncStatus: 'synced' };
}

export const load: PageServerLoad = async ({ url, locals }) => {
	const piId = url.searchParams.get('payment_intent');
	const sessionId = url.searchParams.get('session_id');
	if (!piId && !sessionId) throw error(400, 'Missing payment_intent or session_id query param.');

	const stripe = getStripe();

	try {
		if (piId) {
			const snapshot = await snapshotPaymentIntent(piId);
			const { pi } = snapshot;

			// Only create a contract when the PaymentIntent actually succeeded.
			let contractInfo: { localContractId: string | null; syncStatus: string; syncError?: string } | null = null;
			if (pi.status === 'succeeded') {
				contractInfo = await persistContract(snapshot, locals);
			}

			return {
				flow: 'payment_intent' as const,
				paymentStatus: pi.status,
				amountTotal: pi.amount,
				currency: pi.currency,
				customerEmail: pi.receipt_email,
				productName: snapshot.products[0]?.name ?? null,
				productCount: snapshot.products.length,
				products: snapshot.products.map((p) => p.name),
				contractInfo
			};
		}

		// Checkout Session path — used by the recurring-subscription flow
		// (/api/checkout/subscription) and kept for any stale hosted-Checkout
		// redirects.
		const session = await stripe.checkout.sessions.retrieve(sessionId!, {
			expand: ['line_items']
		});

		let contractInfo: { localContractId: string | null; syncStatus: string; syncError?: string } | null = null;
		if (session.payment_status === 'paid' && session.metadata?.kind === 'subscription') {
			contractInfo = await persistSubscriptionContract(session, locals);
		}

		return {
			flow: 'checkout_session' as const,
			paymentStatus: session.payment_status,
			amountTotal: session.amount_total,
			currency: session.currency,
			customerEmail: session.customer_details?.email ?? null,
			productName: session.line_items?.data?.[0]?.description ?? null,
			productCount: session.line_items?.data?.length ?? 1,
			products: (session.line_items?.data ?? []).map((li) => li.description ?? 'Service'),
			contractInfo
		};
	} catch (e) {
		const desc = describeError(e);
		await logError({
			source: 'stripe.checkout',
			operation: 'retrieve_after_success',
			userId: locals.user?.id ?? null,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { paymentIntentId: piId, sessionId }
		});
		throw error(502, 'Could not load checkout confirmation.');
	}
};
