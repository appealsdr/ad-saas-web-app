/**
 * Salesforce ServiceContract + ContractLineItem sync.
 *
 * Field mapping (Stripe → SF ServiceContract):
 *
 *   AccountId                       — local accounts.sfdc_account_id
 *   ContactId    (standard lookup)  — local users.sfdc_contact_id
 *   Store__c     (custom lookup)    — local stores.sfdc_store_id
 *   Name                            — "<Store Name> <YYYY-MM-DD> Services"
 *   StartDate                       — when the first payment was received (Stripe charge time; subscriptions: activation)
 *   EndDate                         — StartDate + Term months
 *   Term                            — 3
 *   Pricebook2Id                    — SERVICE pricebook
 *
 * ContractLineItem (per purchased item):
 *   ServiceContractId               — parent
 *   PricebookEntryId                — local pricebook_entry_id from selection
 *   Quantity                        — purchased quantity (currently always 1)
 *   UnitPrice                       — from the catalog at purchase time
 *
 * Payment info (Stripe PaymentIntent) is no longer written onto the
 * ServiceContract — it's created as its own Payment__c record instead (see
 * payments.ts), linked to the Case opened for the purchase.
 *
 * If your org renames any of these, update the *_FIELD constants below.
 */
import { sobjectCreate, sobjectUpdate, sobjectDelete, sfdcQuery, SalesforceApiError } from './client';
import { logError } from '../error_log';
import { VUID_FIELD } from './vuid';
import { createServiceCase } from './service-cases';
import { createPayment } from './payments';

// ── SF API names — tweak if your org uses different ones ──
const SERVICE_CONTRACT_FIELDS = {
	contact: 'ContactId',            // standard lookup to Contact
	store: 'Store__c'                // custom lookup
};

export interface ServiceContractInput {
	name: string;                    // Salesforce Name field for the ServiceContract
	/**
	 * 'service' (one-off, from the Service pricebook) vs 'subscription' (recurring
	 * plan). Cases are only auto-created for 'service' — a subscription's Cases
	 * are opened manually by technicians in Salesforce, not by this app.
	 */
	kind: 'service' | 'subscription' | 'recurring';
	sfdcAccountId: string;
	sfdcContactId: string | null;
	sfdcStoreId: string | null;
	sfdcPricebook2Id: string;
	startDate: Date;
	termMonths: number;
	stripe: {
		paymentIntentId: string;
		chargeId: string | null;
		amount: number;                  // in dollars (already divided by 100)
		currency: string;                // ISO code, uppercase
		receiptEmail: string | null;
		paymentMethodId: string | null;
		paymentMethodType: string | null;
	};
	lineItems: Array<{
		pricebookEntryId: string;
		quantity: number;                // recurring: the term in months (UnitPrice is then the monthly price)
		unitPrice: number;
		name: string;                    // service name → Case.Subject
		/**
		 * Part of this line NOT charged at checkout (the rest of a Deposit product). It becomes its own
		 * Pending Payment__c linked to this ContractLineItem, collected when the case is completed.
		 */
		balanceDue?: number;
		/** ContractLineItem.Description (recurring: which month of the term this line is). */
		description?: string;
		/**
		 * Recurring "pay by month": this line is one month's instalment. 'paid' = collected by the checkout charge;
		 * 'due' = a future month (a Not Active payment, Payment_Date__c = its due date). Lines with an instalment
		 * get their own Payment__c linked to the ContractLineItem instead of the contract-level checkout payment.
		 */
		installment?: { status: 'paid' | 'due'; dueDate: Date };
		/** Recurring: 1-based month number (pay in full also uses it, to keep the checkout description to one line per product). */
		monthIndex?: number;
		/** Don't open a Case for this line (later months of a recurring contract share the first month's Case). */
		skipCase?: boolean;
		/** How many Cases to open for this line (default 1). Recurring month 1 opens one per unit bought. */
		caseCount?: number;
	}>;
	sfdcStoreContactId?: string | null;  // store point of contact → Case.ContactId
	localContractId?: string;          // → appealsdoctor_vuid__c
	/** ServiceContract.Payment_Status__c — 'Paid' for a one-off service, 'Subscription' for a recurring plan. */
	paymentStatus?: string;
}

export type ServiceContractResult =
	| {
			ok: true;
			sfdcServiceContractId: string;
			lineItemIds: string[];        // same order as input.lineItems; null entries on per-item failure
		}
	| { ok: false; error: string; errorCode?: string };

function toSfDate(d: Date): string {
	return d.toISOString().slice(0, 10);
}

function addMonths(d: Date, months: number): Date {
	const out = new Date(d.getTime());
	out.setUTCMonth(out.getUTCMonth() + months);
	return out;
}

/** addMonths that stays in the target month (Jan 31 + 1 month = Feb 28, not Mar 3). */
export function addMonthsClamped(d: Date, months: number): Date {
	const out = new Date(d.getTime());
	const day = out.getUTCDate();
	out.setUTCDate(1);
	out.setUTCMonth(out.getUTCMonth() + months);
	const lastDay = new Date(Date.UTC(out.getUTCFullYear(), out.getUTCMonth() + 1, 0)).getUTCDate();
	out.setUTCDate(Math.min(day, lastDay));
	return out;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** "Month 2 of 6 — July 2026": the ContractLineItem description of a recurring month. */
export function recurringMonthDescription(monthIndex: number, termMonths: number, startDate: Date): string {
	const d = addMonthsClamped(startDate, monthIndex - 1);
	return `Month ${monthIndex} of ${termMonths} — ${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export interface RecurringGroup { pricebookEntryId: string; name: string; quantity: number; monthlyPrice: number }

/**
 * Recurring contract lines: a line per product per month of the term. `quantity` is the number of units bought
 * and `unitPrice` the monthly price, so a line is that month's charge ($100 × 5 = $500). 'monthly': month 1 is the
 * paid instalment, the rest are 'due' on start + (month − 1) months. 'full': the same lines, no instalments —
 * the whole term was charged at checkout as one contract-level payment.
 */
export function buildRecurringLines(
	groups: RecurringGroup[], termMonths: number, startDate: Date, payOption: 'full' | 'monthly'
): ServiceContractInput['lineItems'] {
	const out: ServiceContractInput['lineItems'] = [];
	for (let m = 1; m <= termMonths; m++) {
		for (const g of groups) {
			out.push({
				pricebookEntryId: g.pricebookEntryId, quantity: g.quantity, unitPrice: g.monthlyPrice, name: g.name,
				description: recurringMonthDescription(m, termMonths, startDate), monthIndex: m, skipCase: m > 1,
				// One Case per unit bought, all linked to month 1's line item; months 2..N reuse those same Cases.
				...(m === 1 ? { caseCount: Math.max(1, Math.floor(g.quantity)) } : {}),
				...(payOption === 'monthly' ? { installment: { status: m === 1 ? 'paid' as const : 'due' as const, dueDate: addMonthsClamped(startDate, m - 1) } } : {})
			});
		}
	}
	return out;
}

function formatMoney(amount: number, currency: string): string {
	try {
		return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
	} catch {
		// Unknown/invalid ISO code — fall back to a plain two-decimal amount.
		return `${amount.toFixed(2)} ${currency}`;
	}
}

/**
 * Build the ServiceContract Description: one line per purchased line item with
 * its quantity, name and extended price, followed by an overall total.
 *
 *   2 × Roof Inspection — $300.00
 *   1 × Gutter Cleaning — $120.00
 *   ─────────────
 *   Total: $420.00
 */
function buildContractDescription(input: ServiceContractInput): string {
	const currency = input.stripe.currency;
	const lines = input.lineItems.map((li) => {
		const lineTotal = li.unitPrice * li.quantity;
		return `${li.quantity} × ${li.name} — ${formatMoney(lineTotal, currency)}`;
	});
	const computedTotal = input.lineItems.reduce((sum, li) => sum + li.unitPrice * li.quantity, 0);
	const out = [...lines, `Total: ${formatMoney(computedTotal, currency)}`];
	// Deposit services: the order was only partly charged at checkout.
	const balance = input.lineItems.reduce((sum, li) => sum + (li.balanceDue ?? 0), 0);
	if (balance > 0) {
		out.push(`Paid at checkout: ${formatMoney(input.stripe.amount, currency)}`);
		out.push(`Balance, billed per service when each case is completed: ${formatMoney(balance, currency)}`);
	}
	return out.join('\n');
}

/** What already exists in Salesforce for a contract, so a repair only adds what is missing. */
export interface ExistingContractRecords {
	/** Index-aligned with input.lineItems; '' / undefined = not created yet. */
	lineItemIds?: string[];
	/** ContractLineItem Id → Case Id for cases that already exist. */
	caseByLine?: Map<string, string>;
	/** ContractLineItem Id → how many Cases already exist for it (so a repair only adds the missing ones). */
	caseCountByLine?: Map<string, number>;
	/** Any case on the contract (used for payments of lines that have none). */
	anyCaseId?: string | null;
}

export interface PopulateResult {
	lineItemIds: string[];
	created: { lines: number; cases: number; payments: number };
	/** Redundant auto-generated pending payments that were deleted/cancelled. */
	reconciled: { removed: number; cancelled: number };
}

/** How to treat redundant pending payments that Salesforce's own line-item automation generated. */
export type ReconcileMode = 'cancel' | 'delete';

interface SfPaymentRow {
	Id: string; Contract_Line_Item__c: string | null; Payment_Type__c: string | null; Status__c: string | null;
	Stripe_Payment_Intent_Id__c: string | null; Order_Ref__c: string | null;
}

/** Payment types written by Salesforce's own ContractLineItemPaymentService (the app writes 'Service Contract' and 'Balance'). */
const SF_AUTO_TYPES = new Set(['First Payment', 'Deposit', 'Full']);
export const checkoutRef = (localContractId: string) => `${localContractId}:checkout`;
export const balanceRef = (localContractId: string, lineItemId: string) => `${localContractId}:balance:${lineItemId}`;

/**
 * Create whatever the contract is still missing: ContractLineItems, one Case per line, the paid first
 * payment, and one Pending balance payment per deposit line. Every Payment__c carries Case__c — the org's
 * "Payment After Save" flow needs it. Safe to re-run: existing records are skipped.
 */
export async function populateContract(
	sfdcServiceContractId: string,
	input: ServiceContractInput,
	existing: ExistingContractRecords,
	context: { userId?: string; accountId?: string } = {},
	reconcile: ReconcileMode = 'cancel'
): Promise<PopulateResult> {
	const made = { lines: 0, cases: 0, payments: 0 };

	// ── 2. ContractLineItem per purchased entry (parallel; existing ones are kept) ──
	const lineItemIds = await Promise.all(
		input.lineItems.map(async (li, idx): Promise<string> => {
			if (existing.lineItemIds?.[idx]) return existing.lineItemIds[idx];
			// A subscription is a one-year plan, billed as one unit per month: the line item has Quantity = the
			// number of months (12) and a monthly UnitPrice, so Quantity × UnitPrice is the yearly price that was charged.
			const monthly = input.kind === 'subscription' && input.termMonths > 0;
			const payload: Record<string, unknown> = {
				ServiceContractId: sfdcServiceContractId,
				PricebookEntryId: li.pricebookEntryId,
				Quantity: monthly ? input.termMonths : li.quantity,
				UnitPrice: monthly ? Math.round(((li.unitPrice * li.quantity) / input.termMonths) * 100) / 100 : li.unitPrice
			};
			if (li.description) payload.Description = li.description;
			try {
				const res = await sobjectCreate('ContractLineItem', payload);
				if (!res.success) {
					await logError({
						source: 'salesforce.contracts', operation: 'create_contract_line_item', severity: 'warn',
						userId: context.userId, accountId: context.accountId, sfdcObject: 'ContractLineItem',
						errorMessage: `ContractLineItem create returned success=false: ${JSON.stringify(res.errors)}`,
						context: { payload, sfdcServiceContractId }
					});
					return '';
				}
				made.lines++;
				return res.id;
			} catch (e) {
				const isSfErr = e instanceof SalesforceApiError;
				await logError({
					source: 'salesforce.contracts', operation: 'create_contract_line_item', severity: 'warn',
					userId: context.userId, accountId: context.accountId, sfdcObject: 'ContractLineItem',
					errorCode: (e instanceof SalesforceApiError ? e.errorCode : undefined) ?? (isSfErr ? String(e.status) : undefined),
					errorMessage: e instanceof Error ? e.message : String(e),
					stack: e instanceof Error ? e.stack : undefined,
					context: { payload, sfdcServiceContractId }
				});
				return '';
			}
		})
	);

	// ── 3. One Case per ContractLineItem that has none (best-effort) ──
	//    Subject = service name; Contract__c / Contract_Line_Item__c link back; ContactId = the store's
	//    point of contact. Subscriptions are excluded: their Cases are opened manually in Salesforce.
	const caseByLine = new Map<string, string>(existing.caseByLine ?? []);
	if (input.kind !== 'subscription') {
		await Promise.all(
			input.lineItems.map(async (li, i) => {
				const lineItemId = lineItemIds[i];
				if (!lineItemId || li.skipCase) return; // CLI failed → no case
				const wanted = Math.max(1, li.caseCount ?? 1);
				const have = existing.caseCountByLine?.get(lineItemId) ?? (caseByLine.has(lineItemId) ? 1 : 0);
				for (let n = have; n < wanted; n++) {
					const res = await createServiceCase(
						{
							sfdcContractId: sfdcServiceContractId, sfdcContractLineItemId: lineItemId, subject: li.name,
							sfdcAccountId: input.sfdcAccountId, sfdcStoreId: input.sfdcStoreId,
							sfdcContactId: input.sfdcStoreContactId ?? input.sfdcContactId
						},
						context
					);
					if (res.ok) { if (!caseByLine.has(lineItemId)) caseByLine.set(lineItemId, res.id); made.cases++; }
				}
			})
		);
	}
	// Payments need a Case (see PaymentInput.sfdcCaseId). The contract-level payment uses the first line's case.
	const firstCaseId =
		input.lineItems.map((_, i) => caseByLine.get(lineItemIds[i])).find((c): c is string => !!c) ?? existing.anyCaseId ?? null;

	// ── 4-5. Payments — idempotent: look at what the contract already has, create only what is missing ──
	//    Retries, the repair action and Salesforce's own line-item automation (which can add its own pending
	//    "First Payment"/"Deposit"/"Full" records) must never produce a second checkout or balance record.
	let existingPays: SfPaymentRow[] = [];
	try {
		existingPays = (await sfdcQuery<SfPaymentRow>(
			`SELECT Id, Contract_Line_Item__c, Payment_Type__c, Status__c, Stripe_Payment_Intent_Id__c, Order_Ref__c FROM Payment__c WHERE Service_Contract__c = '${sfdcServiceContractId}'`,
			{ paginate: true }
		)).records;
	} catch {
		existingPays = []; // can't tell → fall through; the create calls below are individually best-effort
	}
	const localRef = input.localContractId;
	const hasCheckout = existingPays.some(
		(p) => p.Stripe_Payment_Intent_Id__c === input.stripe.paymentIntentId || (localRef && p.Order_Ref__c === checkoutRef(localRef))
	);
	const hasBalance = (lineItemId: string, li: { name: string }) =>
		existingPays.some(
			(p) => p.Contract_Line_Item__c === lineItemId && (p.Payment_Type__c === 'Balance' || (localRef && p.Order_Ref__c === balanceRef(localRef, lineItemId)))
		);

	// 4. ONE contract-level payment for what was actually charged, itemised. Paid only because the Stripe charge succeeded.
	// Recurring pay-by-month: every month is its own Payment__c on its own line (step 4b); no contract-level payment.
	const installmentMode = input.lineItems.some((li) => !!li.installment);
	let haveCheckout = hasCheckout;
	if (!hasCheckout && !installmentMode) {
		const checkout = (description: string) =>
			createPayment(
				{
					amount: input.stripe.amount, currency: input.stripe.currency, description,
					paymentType: 'Service Contract',
					stripe: { paymentIntentId: input.stripe.paymentIntentId, paymentMethodId: input.stripe.paymentMethodId },
					sfdcServiceContractId, sfdcCaseId: firstCaseId, orderRef: localRef ? checkoutRef(localRef) : null,
					paymentDate: input.startDate // Payment_Date__c = the day the client paid via Stripe
				},
				context
			);
		let res = await checkout(buildCheckoutPaymentDescription(input));
		// The collected payment is the record that matters most — never lose it to a description problem.
		if (!res.ok) res = await checkout(`Checkout payment of ${formatMoney(input.stripe.amount, input.stripe.currency)}`);
		if (res.ok) { made.payments++; haveCheckout = true; }
	}

	// 4b. Pay by month: one Payment__c per month, linked to that month's ContractLineItem. Month 1 is the checkout charge
	//     (Paid, Payment_Date__c = the start date = the Stripe payment day); later months are Not Active 'Balance'
	//     payments dated when they fall due — Payment_Date__c becomes the actual Stripe date when the client pays them.
	if (installmentMode) {
		await Promise.all(
			input.lineItems.map(async (li, i) => {
				const lineItemId = lineItemIds[i];
				if (!lineItemId || !li.installment) return;
				const amount = Math.round(li.unitPrice * li.quantity * 100) / 100;
				const paid = li.installment.status === 'paid';
				const ref = localRef ? `${localRef}:installment:${i}` : null;
				const exists = existingPays.some(
					(p) => (paid && p.Stripe_Payment_Intent_Id__c === input.stripe.paymentIntentId) || (ref && p.Order_Ref__c === ref) ||
						(!paid && p.Contract_Line_Item__c === lineItemId && p.Payment_Type__c === 'Balance')
				);
				if (exists) { if (paid) haveCheckout = true; return; }
				const res = await createPayment(
					{
						amount, currency: input.stripe.currency,
						description: `${li.name} — ${li.description ?? 'monthly payment'}`,
						paymentType: paid ? 'Service Contract' : 'Balance', status: paid ? 'Paid' : 'Not Active',
						...(paid ? { stripe: { paymentIntentId: input.stripe.paymentIntentId, paymentMethodId: input.stripe.paymentMethodId }, paidAt: input.startDate } : {}),
						paymentDate: paid ? input.startDate : li.installment.dueDate,
						sfdcServiceContractId, sfdcContractLineItemId: lineItemId,
						sfdcCaseId: caseByLine.get(lineItemId) ?? firstCaseId, orderRef: ref
					},
					context
				);
				if (res.ok) { made.payments++; if (paid) haveCheckout = true; }
			})
		);
	}

	// 5. Deposit services: one balance payment per line for the part not charged yet — created Not Active,
	//    moved to 'Request Payment' (in Salesforce) when the case completes or a payment is requested.
	//    Linked to the contract, the ContractLineItem and that line's Case; collected when the case is completed.
	await Promise.all(
		input.lineItems.map(async (li, i) => {
			const lineItemId = lineItemIds[i];
			const balance = Math.round((li.balanceDue ?? 0) * 100) / 100;
			if (!lineItemId || balance <= 0 || hasBalance(lineItemId, li)) return;
			const res = await createPayment(
				{
					amount: balance, currency: input.stripe.currency,
					description: `Remaining balance for ${li.name} — collect when its case is completed`,
					paymentType: 'Balance', status: 'Not Active',
					sfdcServiceContractId, sfdcContractLineItemId: lineItemId,
					sfdcCaseId: caseByLine.get(lineItemId) ?? firstCaseId, orderRef: localRef ? balanceRef(localRef, lineItemId) : null
				},
				context
			);
			if (res.ok) made.payments++;
		})
	);

	// 6. Reconcile: the deposits are components of the single checkout charge, so the pending First Payment /
	//    Deposit / Full records generated by Salesforce's automation are redundant. Only ever touches PENDING
	//    records of those types with no Stripe charge, and only once the paid checkout payment exists.
	const reconciled = { removed: 0, cancelled: 0 };
	// Balances this app created earlier as 'Pending' become 'Not Active' (not collectible until requested).
	for (const p of existingPays) {
		if (p.Payment_Type__c === 'Balance' && p.Status__c === 'Pending' && !p.Stripe_Payment_Intent_Id__c) {
			try { await sobjectUpdate('Payment__c', p.Id, { Status__c: 'Not Active' }); } catch { /* picklist value not available yet */ }
		}
	}
	if (haveCheckout) {
		// Pending ones always; Cancelled ones too when deleting (left behind by an earlier cancel-only clean-up).
		const redundant = existingPays.filter(
			(p) =>
				(p.Status__c === 'Pending' || (reconcile === 'delete' && p.Status__c === 'Cancelled')) &&
				SF_AUTO_TYPES.has(p.Payment_Type__c ?? '') && !p.Stripe_Payment_Intent_Id__c
		);
		for (const p of redundant) {
			try {
				if (reconcile === 'delete') { await sobjectDelete('Payment__c', p.Id); reconciled.removed++; }
				else { await sobjectUpdate('Payment__c', p.Id, { Status__c: 'Cancelled' }); reconciled.cancelled++; }
			} catch (e) {
				try {
					if (reconcile === 'delete') { await sobjectUpdate('Payment__c', p.Id, { Status__c: 'Cancelled' }); reconciled.cancelled++; }
				} catch { /* leave it; reported by the caller's counts */ }
				await logError({
					source: 'salesforce.contracts', operation: 'reconcile_redundant_payment', severity: 'warn', accountId: context.accountId,
					sfdcObject: 'Payment__c', errorMessage: e instanceof Error ? e.message : String(e), context: { paymentId: p.Id, mode: reconcile }
				});
			}
		}
	}

		return { lineItemIds, created: made, reconciled };
}

/**
 * Description of the single checkout payment: what the one charge covers, per line
 * ("FBM Account Suspension in full ($3,000.00); A-Z Claims deposit ($150.00); …").
 */
export function buildCheckoutPaymentDescription(input: ServiceContractInput): string {
	const currency = input.stripe.currency;
	// Group identical lines ("2 × A-Z Claims deposit ($300.00)") — Payment__c.Description__c holds 255 characters.
	const groups = new Map<string, { label: string; qty: number; now: number }>();
	for (const li of input.lineItems) {
		const now = li.unitPrice * li.quantity - (li.balanceDue ?? 0);
		if (li.installment && li.installment.status === 'due') continue; // not charged at checkout
		const label = (li.balanceDue ?? 0) > 0 ? `${li.name} deposit` : `${li.name} in full`;
		const g = groups.get(label) ?? { label, qty: 0, now: 0 };
		if ((li.monthIndex ?? 1) <= 1) g.qty += 1; // later months of the same product are part of that one line
		g.now += now;
		groups.set(label, g);
	}
	const parts = [...groups.values()].map((g) => `${g.qty > 1 ? `${g.qty} × ` : ''}${g.label} (${formatMoney(g.now, currency)})`);
	return `Checkout payment of ${formatMoney(input.stripe.amount, currency)} — one transaction covering ${parts.join('; ')}.`;
}

/**
 * Create a ServiceContract for the purchase, then create a ContractLineItem
 * for each purchased catalog entry. Returns the SF Ids on success.
 *
 * The ServiceContract create runs in one POST; the line items run in parallel
 * — slower SF orgs benefit from this. If a line item fails its id is null
 * in the returned array but the ServiceContract itself is still considered
 * successful (caller can retry orphans).
 */
export async function createServiceContractWithLines(
	input: ServiceContractInput,
	context: { userId?: string; accountId?: string } = {}
): Promise<ServiceContractResult> {
	const startDate = input.startDate;
	const endDate = addMonths(startDate, input.termMonths);

	const contractPayload: Record<string, unknown> = {
		Name: input.name,
		AccountId: input.sfdcAccountId,
		Description: buildContractDescription(input),
		StartDate: toSfDate(startDate),
		EndDate: toSfDate(endDate),
		Term: input.termMonths,
		Pricebook2Id: input.sfdcPricebook2Id
	};
	if (input.sfdcContactId) contractPayload[SERVICE_CONTRACT_FIELDS.contact] = input.sfdcContactId;
	if (input.sfdcStoreId) contractPayload[SERVICE_CONTRACT_FIELDS.store] = input.sfdcStoreId;
	if (input.localContractId) contractPayload[VUID_FIELD] = input.localContractId;
	if (input.paymentStatus) contractPayload['Payment_Status__c'] = input.paymentStatus;

	// ── 1. ServiceContract ──
	let sfdcServiceContractId: string;
	try {
		const created = await sobjectCreate('ServiceContract', contractPayload);
		if (!created.success) {
			const error = `Salesforce ServiceContract create returned success=false: ${JSON.stringify(created.errors)}`;
			await logError({
				source: 'salesforce.contracts',
				operation: 'create_service_contract',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: 'ServiceContract',
				errorMessage: error,
				context: { payload: contractPayload, stripePaymentIntentId: input.stripe.paymentIntentId }
			});
			return { ok: false, error };
		}
		sfdcServiceContractId = created.id;
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.contracts',
			operation: 'create_service_contract',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'ServiceContract',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { payload: contractPayload, stripePaymentIntentId: input.stripe.paymentIntentId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}

	// ── 2-5. Line items, cases, the paid payment and the balance payments ──
	// 'delete': Salesforce's own line-item automation may have just generated redundant pending payments on this brand-new
	// contract — remove them so only the checkout payment and the balances exist (no leftover Cancelled duplicates).
	const { lineItemIds } = await populateContract(sfdcServiceContractId, input, {}, context, 'delete');
	return { ok: true, sfdcServiceContractId, lineItemIds };
}
