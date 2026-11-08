/**
 * Payment__c record creation.
 *
 * Payment info for a Stripe charge used to be written directly onto the
 * ServiceContract (see contracts.ts). It now lives on its own Payment__c
 * object instead, linked back to the ServiceContract (and, if known, the
 * Opportunity).
 *
 *   Amount__c                       — PaymentIntent.amount / 100
 *   Total_Paid__c                   — PaymentIntent.amount / 100
 *   CurrencyIsoCode__c              — PaymentIntent.currency, uppercase
 *   Stripe_Payment_Intent_Id__c     — PaymentIntent.id
 *   Stripe_Checkout_Session_Id__c   — Checkout Session id, if applicable
 *   Stripe_EventId__c               — Stripe webhook event id, if applicable
 *   Payment_Method__c               — PaymentIntent.payment_method
 *   Payment_Type__c                 — e.g. "Service Contract"
 *   Status__c                       — Payment__c picklist value, e.g. "Paid"
 *   PaidAt__c                       — ISO timestamp the payment succeeded
 *   Description__c                  — human-readable summary
 *   Service_Contract__c             — the ServiceContract this payment is for
 *   Opportunity__c                  — related Opportunity, if any
 *   Order_Ref__c / Guest_Order_Id__c / Amount_Applied__c —
 *     optional local reference fields
 *
 * If your org renames any of these, update PAYMENT_FIELDS below.
 */
import { sobjectCreate, SalesforceApiError } from './client';
import { logError } from '../error_log';

const PAYMENT_OBJECT = 'Payment__c';

const PAYMENT_FIELDS = {
	amount: 'Amount__c',
	amountApplied: 'Amount_Applied__c',
	currencyIsoCode: 'CurrencyIsoCode__c',
	depositDateTime: 'Deposit_Date_Time__c',
	description: 'Description__c',
	guestOrderId: 'Guest_Order_Id__c',
	opportunity: 'Opportunity__c',
	orderRef: 'Order_Ref__c',
	paidAt: 'PaidAt__c',
	paymentDate: 'Payment_Date__c',
	paymentMethod: 'Payment_Method__c',
	paymentType: 'Payment_Type__c',
	serviceContract: 'Service_Contract__c',
	status: 'Status__c',
	stripeCheckoutSessionId: 'Stripe_Checkout_Session_Id__c',
	stripeEventId: 'Stripe_EventId__c',
	stripePaymentIntentId: 'Stripe_Payment_Intent_Id__c',
	totalPaid: 'Total_Paid__c',
	contractLineItem: 'Contract_Line_Item__c',
	case: 'Case__c'
};

export interface PaymentInput {
	amount: number; // in dollars (already divided by 100)
	currency: string; // ISO code, uppercase
	description?: string | null;
	status?: string; // Payment__c Status__c picklist value
	paymentType?: string | null; // e.g. "Service Contract"
	paidAt?: Date;
	/**
	 * Payment_Date__c (date). A collected payment: the day the client paid via Stripe (defaults to paidAt/now).
	 * A scheduled, not-yet-paid installment: the day it falls due.
	 */
	paymentDate?: Date;
	/** Stripe references. Omitted for a payment that has not been collected yet (status Pending). */
	stripe?: {
		paymentIntentId: string;
		checkoutSessionId?: string | null;
		eventId?: string | null;
		paymentMethodId?: string | null;
	};
	sfdcServiceContractId?: string | null;
	/** The ContractLineItem this payment is for (e.g. the balance of one deposit service). */
	sfdcContractLineItemId?: string | null;
	/**
	 * The Case this payment belongs to. REQUIRED by the org's "Payment After Save" flow, which looks the Case
	 * up and notifies its owner — a Payment__c without one fails to save ("Invalid parameter value for: recipientIds").
	 */
	sfdcCaseId?: string | null;
	sfdcOpportunityId?: string | null;
	orderRef?: string | null;
	guestOrderId?: string | null;
	amountApplied?: string | null;
}

export type PaymentResult = { ok: true; id: string } | { ok: false; error: string; errorCode?: string };

/** Create one Payment__c record for a Stripe charge. */
export async function createPayment(
	input: PaymentInput,
	context: { userId?: string; accountId?: string } = {}
): Promise<PaymentResult> {
	const status = input.status ?? 'Paid';
	const paid = status === 'Paid';
	const payload: Record<string, unknown> = {
		[PAYMENT_FIELDS.amount]: input.amount,
		[PAYMENT_FIELDS.currencyIsoCode]: input.currency,
		[PAYMENT_FIELDS.status]: status
	};
	if (paid) {
		payload[PAYMENT_FIELDS.totalPaid] = input.amount;
		payload[PAYMENT_FIELDS.paidAt] = (input.paidAt ?? new Date()).toISOString();
	}
	const payDate = input.paymentDate ?? (paid ? (input.paidAt ?? new Date()) : null);
	if (payDate) payload[PAYMENT_FIELDS.paymentDate] = payDate.toISOString().slice(0, 10);
	if (input.stripe) {
		payload[PAYMENT_FIELDS.stripePaymentIntentId] = input.stripe.paymentIntentId;
		if (input.stripe.paymentMethodId) payload[PAYMENT_FIELDS.paymentMethod] = input.stripe.paymentMethodId;
	}
	if (input.sfdcContractLineItemId) payload[PAYMENT_FIELDS.contractLineItem] = input.sfdcContractLineItemId;
	if (input.sfdcCaseId) payload[PAYMENT_FIELDS.case] = input.sfdcCaseId;
	// Description__c is a 255-character field; a longer value makes Salesforce reject the whole payment.
	if (input.description) payload[PAYMENT_FIELDS.description] = input.description.length > 255 ? input.description.slice(0, 254) + '…' : input.description;
	if (input.paymentType) payload[PAYMENT_FIELDS.paymentType] = input.paymentType;
	if (input.stripe?.checkoutSessionId) payload[PAYMENT_FIELDS.stripeCheckoutSessionId] = input.stripe.checkoutSessionId;
	if (input.stripe?.eventId) payload[PAYMENT_FIELDS.stripeEventId] = input.stripe.eventId;
	if (input.sfdcServiceContractId) {
		payload[PAYMENT_FIELDS.serviceContract] = input.sfdcServiceContractId;
	}
	if (input.sfdcOpportunityId) payload[PAYMENT_FIELDS.opportunity] = input.sfdcOpportunityId;
	if (input.orderRef) payload[PAYMENT_FIELDS.orderRef] = input.orderRef;
	if (input.guestOrderId) payload[PAYMENT_FIELDS.guestOrderId] = input.guestOrderId;
	if (input.amountApplied) payload[PAYMENT_FIELDS.amountApplied] = input.amountApplied;

	try {
		let created;
		try {
			created = await sobjectCreate(PAYMENT_OBJECT, payload);
		} catch (e) {
			// The org's Status__c picklist may not have the newer value ('Not Active') yet: fall back to Pending
			// rather than losing the record. The app treats a Pending balance exactly like Not Active.
			const msg = e instanceof Error ? e.message : '';
			if (status === 'Not Active' && /restricted picklist|INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST|bad value/i.test(msg)) {
				created = await sobjectCreate(PAYMENT_OBJECT, { ...payload, [PAYMENT_FIELDS.status]: 'Pending' });
			} else {
				throw e;
			}
		}
		if (!created.success) {
			const error = `Salesforce Payment__c create returned success=false: ${JSON.stringify(created.errors)}`;
			await logError({
				source: 'salesforce.payments',
				operation: 'create_payment',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: PAYMENT_OBJECT,
				errorMessage: error,
				context: { payload, stripePaymentIntentId: input.stripe?.paymentIntentId ?? null }
			});
			return { ok: false, error };
		}
		return { ok: true, id: created.id };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.payments',
			operation: 'create_payment',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: PAYMENT_OBJECT,
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { payload, stripePaymentIntentId: input.stripe?.paymentIntentId ?? null }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}
