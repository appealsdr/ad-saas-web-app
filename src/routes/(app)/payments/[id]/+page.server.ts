/**
 * One service contract: header info + every purchased line item.
 * Tenancy: the contract's account_id must match the signed-in user's.
 */
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { listCasesForContract } from '$lib/server/salesforce';

interface ContractRow {
	id: string;
	account_id: string;
	store_id: string | null;
	store_name: string | null;
	stripe_payment_intent_id: string;
	stripe_charge_id: string | null;
	stripe_payment_method_id: string | null;
	stripe_payment_method_type: string | null;
	stripe_receipt_email: string | null;
	amount_cents: bigint;
	currency: string;
	paid_at: Date;
	start_date: Date;
	end_date: Date;
	term_months: number;
	sfdc_service_contract_id: string | null;
	sfdc_account_id: string | null;
	sfdc_contact_id: string | null;
	sfdc_store_id: string | null;
	sync_status: string;
	sync_error: string | null;
	synced_at: Date | null;
	created_at: Date;
}

interface LineItemRow {
	id: string;
	product_name: string;
	product_description: string | null;
	product_category: string | null;
	sfdc_product_id: string | null;
	sfdc_pricebook_entry_id: string | null;
	sfdc_contract_line_item_id: string | null;
	unit_price: string;          // numeric → string in postgres.js
	quantity: number;
	currency: string;
	created_at: Date;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const [contract] = await sql<ContractRow[]>`
		SELECT c.*, s.name AS store_name
		FROM service_contracts c
		LEFT JOIN stores s ON s.id = c.store_id
		JOIN users u ON u.id = ${locals.user.id}
		WHERE c.id = ${params.id} AND c.account_id = u.account_id
		LIMIT 1
	`;
	if (!contract) throw error(404, 'Contract not found.');

	const lines = await sql<LineItemRow[]>`
		SELECT id, product_name, product_description, product_category,
		       sfdc_product_id, sfdc_pricebook_entry_id, sfdc_contract_line_item_id,
		       unit_price, quantity, currency, created_at
		FROM service_contract_line_items
		WHERE service_contract_id = ${contract.id}
		ORDER BY created_at ASC
	`;

	// Cases auto-created for this contract (filter Case.Contract__c).
	const casesResult = contract.sfdc_service_contract_id
		? await listCasesForContract(contract.sfdc_service_contract_id)
		: null;
	const cases = casesResult && casesResult.ok ? casesResult.cases : [];
	const casesError = casesResult && !casesResult.ok ? casesResult.error : null;

	return {
		localStoreId: contract.store_id,
		cases,
		casesError,
		contract: {
			id: contract.id,
			storeId: contract.store_id,
			storeName: contract.store_name,
			stripePaymentIntentId: contract.stripe_payment_intent_id,
			stripeChargeId: contract.stripe_charge_id,
			stripePaymentMethodId: contract.stripe_payment_method_id,
			stripePaymentMethodType: contract.stripe_payment_method_type,
			stripeReceiptEmail: contract.stripe_receipt_email,
			amountCents: Number(contract.amount_cents),
			currency: contract.currency,
			paidAt: contract.paid_at.toISOString(),
			startDate: contract.start_date.toISOString().slice(0, 10),
			endDate: contract.end_date.toISOString().slice(0, 10),
			termMonths: contract.term_months,
			sfdcServiceContractId: contract.sfdc_service_contract_id,
			sfdcAccountId: contract.sfdc_account_id,
			sfdcContactId: contract.sfdc_contact_id,
			sfdcStoreId: contract.sfdc_store_id,
			syncStatus: contract.sync_status,
			syncError: contract.sync_error,
			syncedAt: contract.synced_at?.toISOString() ?? null,
			createdAt: contract.created_at.toISOString()
		},
		lineItems: lines.map((l) => ({
			id: l.id,
			productName: l.product_name,
			productDescription: l.product_description,
			productCategory: l.product_category,
			sfdcProductId: l.sfdc_product_id,
			sfdcPricebookEntryId: l.sfdc_pricebook_entry_id,
			sfdcContractLineItemId: l.sfdc_contract_line_item_id,
			unitPrice: Number(l.unit_price),
			quantity: l.quantity,
			currency: l.currency
		}))
	};
};
