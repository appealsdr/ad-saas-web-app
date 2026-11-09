/**
 * Salesforce presence checks and manual re-sync for records the app mirrors to
 * Salesforce (Account, Contact, Store__c, ServiceContract).
 *
 * A local `sfdc_*_id` only proves a link was once stored — the Salesforce
 * record may since have been deleted. So state is derived from a live lookup:
 *
 *   synced      linked and the record exists in Salesforce
 *   not_in_sf   not linked, OR linked to a record Salesforce no longer has
 *   unknown     Salesforce could not be queried (never reported as "synced")
 *
 * Re-sync always re-reads local state, creates the record when it is missing in
 * Salesforce (replacing a stale link), or pushes the current local values when
 * it exists. Every attempt is audited.
 */
import { sql } from '../db';
import { sfdcQuery, sobjectUpdate } from '../salesforce/client';
import {
	createSalesforceAccountAndContact,
	createSalesforceContactForAccount,
	splitFullName
} from '../salesforce/sync';
import { createSalesforceStore, updateSalesforceStore } from '../salesforce/stores';
import { createServiceContractWithLines, populateContract, recurringMonthDescription, addMonthsClamped, type ServiceContractInput } from '../salesforce/contracts';
import { updateSalesforceAccount, updateSalesforceContact } from '../salesforce/records';
import { logError } from '../error_log';
import { recordAudit, type AuditActor } from './audit';
import { ActionError, requireReason } from './actions';

export type SfState = 'synced' | 'not_in_sf' | 'unknown';
export type SfObject = 'Account' | 'Contact' | 'Store__c' | 'ServiceContract';

/** Ids that exist in Salesforce, or null when Salesforce could not be queried. */
export async function sfExisting(object: SfObject, ids: (string | null | undefined)[]): Promise<Set<string> | null> {
	const clean = [...new Set(ids.filter((i): i is string => !!i && /^[a-zA-Z0-9]{15,18}$/.test(i)))];
	const found = new Set<string>();
	if (!clean.length) return found;
	try {
		for (let i = 0; i < clean.length; i += 150) {
			const list = clean.slice(i, i + 150).map((id) => `'${id}'`).join(',');
			const res = await sfdcQuery<{ Id: string }>(`SELECT Id FROM ${object} WHERE Id IN (${list})`, { paginate: true });
			for (const r of res.records) {
				found.add(r.Id);
				if (r.Id.length === 18) found.add(r.Id.slice(0, 15));
			}
		}
		return found;
	} catch (e) {
		await logError({
			source: 'admin.sf_sync',
			operation: 'presence_check',
			sfdcObject: object,
			errorMessage: e instanceof Error ? e.message : String(e)
		});
		return null;
	}
}

export function sfState(id: string | null | undefined, existing: Set<string> | null): SfState {
	if (!id) return 'not_in_sf';
	if (existing === null) return 'unknown';
	return existing.has(id) || existing.has(id.slice(0, 15)) ? 'synced' : 'not_in_sf';
}

interface Ctx {
	actor: AuditActor;
	ip?: string | null;
}

export type ResyncKind = 'account' | 'user' | 'store' | 'contract';
/**
 * create  — the record is not in Salesforce (never created, creation failed, or the link is stale):
 *           create it and store the new id. Refused if it already exists, to avoid duplicates.
 * update  — the record exists in Salesforce: push the current local values. Refused if it does not.
 * repair  — (contracts only) the contract exists but its line items, cases or payments are incomplete
 *           (e.g. a Salesforce automation rejected some records): create only what is missing.
 */
export type SyncMode = 'create' | 'update' | 'repair';
export interface ResyncResult {
	message: string;
}

async function audit(
	ctx: Ctx,
	accountId: string,
	kind: ResyncKind,
	targetId: string,
	outcome: 'success' | 'failure',
	reason: string,
	metadata: Record<string, unknown>
) {
	await recordAudit(
		{
			actor: ctx.actor,
			action: `${kind}.salesforce_resync`,
			targetType: kind,
			targetId,
			targetAccountId: accountId,
			outcome,
			reason,
			ip: ctx.ip,
			metadata
		},
		undefined,
		{ bestEffort: true }
	);
}

export async function resyncRecord(
	ctx: Ctx,
	accountId: string,
	kind: ResyncKind,
	targetId: string,
	reason: string | null,
	mode: SyncMode = 'update'
): Promise<ResyncResult> {
	const why = requireReason(reason);
	try {
		const message =
			kind === 'account'
				? await resyncAccount(accountId, mode)
				: kind === 'user'
					? await resyncUser(accountId, targetId, mode)
					: kind === 'contract'
						? await resyncContract(accountId, targetId, mode)
						: await resyncStore(accountId, targetId, mode);
		await audit(ctx, accountId, kind, targetId, 'success', why, { message, mode });
		return { message };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await audit(ctx, accountId, kind, targetId, 'failure', why, { error: msg, mode });
		throw e instanceof ActionError ? e : new ActionError(`Salesforce sync failed: ${msg}`, 502);
	}
}

/** Enforce the chosen mode against the live Salesforce state. */
function requireMode(mode: SyncMode, present: boolean, what: string) {
	if (mode === 'repair') {
		if (what !== 'contract') throw new ActionError('Only contracts can be completed this way.', 409);
		if (!present) throw new ActionError('This contract is not in Salesforce — use "Create in Salesforce" instead.', 409);
		return;
	}
	if (mode === 'create' && present) {
		throw new ActionError(`This ${what} already exists in Salesforce — use "Sync to Salesforce" to update it. Creating it again would make a duplicate.`, 409);
	}
	if (mode === 'update' && !present) {
		throw new ActionError(`This ${what} is not in Salesforce yet — use "Create in Salesforce" first.`, 409);
	}
}

async function resyncAccount(accountId: string, mode: SyncMode): Promise<string> {
	const [a] = await sql<
		{
			name: string; email: string | null; phone: string | null; website: string | null; sfdc_account_id: string | null;
			created_at: Date; billing_street: string | null; billing_city: string | null; billing_state: string | null;
			billing_postal_code: string | null; billing_country: string | null;
		}[]
	>`SELECT name, email, phone, website, sfdc_account_id, created_at, billing_street, billing_city, billing_state,
	         billing_postal_code, billing_country FROM accounts WHERE id = ${accountId}`;
	if (!a) throw new ActionError('Account not found.', 404);
	const ctx = { accountId };

	const existing = await sfExisting('Account', [a.sfdc_account_id]);
	if (existing === null) throw new ActionError('Salesforce is unreachable right now. Try again shortly.', 502);

	requireMode(mode, sfState(a.sfdc_account_id, existing) === 'synced', 'account');
	if (mode === 'update') {
		const r = await updateSalesforceAccount(
			a.sfdc_account_id!,
			{
				Name: a.name,
				Phone: a.phone,
				Website: a.website,
				BillingStreet: a.billing_street,
				BillingCity: a.billing_city,
				BillingState: a.billing_state,
				BillingPostalCode: a.billing_postal_code,
				BillingCountry: a.billing_country
			},
			ctx
		);
		if (!r.ok) throw new ActionError(r.error, 502);
		return 'Account already in Salesforce — current values pushed.';
	}

	// Missing in Salesforce: recreate the Account together with the owner's Contact.
	const [owner] = await sql<{ id: string; email: string; display_name: string | null }[]>`
		SELECT id, email, display_name FROM users WHERE account_id = ${accountId} AND role = 'owner'
		ORDER BY created_at, id LIMIT 1`;
	if (!owner) throw new ActionError('This account has no owner user to create the Salesforce Contact from.', 409);
	const { firstName, lastName } = splitFullName(owner.display_name ?? owner.email);
	const res = await createSalesforceAccountAndContact(
		{
			companyName: a.name,
			firstName,
			lastName,
			email: a.email ?? owner.email,
			phone: a.phone ?? '',
			website: a.website ?? '',
			startDate: a.created_at
		},
		{ userId: owner.id, accountId }
	);
	if (!res.ok) throw new ActionError(res.error, 502);
	await sql.begin(async (tx) => {
		await tx`UPDATE accounts SET sfdc_account_id = ${res.sfdcAccountId} WHERE id = ${accountId}`;
		await tx`UPDATE users SET sfdc_account_id = ${res.sfdcAccountId} WHERE account_id = ${accountId}`;
		await tx`UPDATE users SET sfdc_contact_id = ${res.sfdcContactId} WHERE id = ${owner.id}`;
		// Stores/contacts that pointed at the old (missing) Account must be re-synced individually.
	});
	return a.sfdc_account_id
		? 'Account was missing in Salesforce — recreated and relinked (re-sync its users and stores too).'
		: 'Account created in Salesforce.';
}

async function resyncUser(accountId: string, userId: string, mode: SyncMode): Promise<string> {
	const [u] = await sql<
		{ id: string; email: string; display_name: string | null; sfdc_contact_id: string | null }[]
	>`SELECT id, email, display_name, sfdc_contact_id FROM users WHERE id = ${userId} AND account_id = ${accountId}`;
	if (!u) throw new ActionError('User not found on this account.', 404);
	const [a] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	const [accountPresent, contactPresent] = await Promise.all([
		sfExisting('Account', [a?.sfdc_account_id]),
		sfExisting('Contact', [u.sfdc_contact_id])
	]);
	if (accountPresent === null || contactPresent === null) throw new ActionError('Salesforce is unreachable right now. Try again shortly.', 502);
	const ctx = { userId: u.id, accountId };
	const { firstName, lastName } = splitFullName(u.display_name ?? u.email);

	requireMode(mode, sfState(u.sfdc_contact_id, contactPresent) === 'synced', 'contact');
	if (mode === 'update') {
		const r = await updateSalesforceContact(u.sfdc_contact_id!, { FirstName: firstName ?? null, LastName: lastName }, ctx);
		if (!r.ok) throw new ActionError(r.error, 502);
		return 'Contact already in Salesforce — current values pushed.';
	}
	if (sfState(a?.sfdc_account_id, accountPresent) !== 'synced') {
		throw new ActionError('The account is not in Salesforce. Re-sync the account first.', 409);
	}
	const res = await createSalesforceContactForAccount(
		{ sfdcAccountId: a!.sfdc_account_id!, firstName, lastName, email: u.email, localUserId: u.id },
		ctx
	);
	if (!res.ok) throw new ActionError(res.error, 502);
	await sql`UPDATE users SET sfdc_contact_id = ${res.sfdcContactId}, sfdc_account_id = ${a!.sfdc_account_id} WHERE id = ${u.id}`;
	await sql`UPDATE account_contacts SET sfdc_contact_id = ${res.sfdcContactId} WHERE account_id = ${accountId} AND user_id = ${u.id}`;
	return u.sfdc_contact_id ? 'Contact was missing in Salesforce — recreated and relinked.' : 'Contact created in Salesforce.';
}

async function resyncStore(accountId: string, storeId: string, mode: SyncMode): Promise<string> {
	const [s] = await sql<
		{
			id: string; name: string; marketplaces: string | null; seller_id: string | null; seller_primary_email: string | null;
			store_email: string | null; business_name: string | null; country: string | null; description: string | null;
			sfdc_store_id: string | null;
		}[]
	>`SELECT id, name, marketplaces, seller_id, seller_primary_email, store_email, business_name, country, description, sfdc_store_id
	  FROM stores WHERE id = ${storeId} AND account_id = ${accountId}`;
	if (!s) throw new ActionError('Store not found on this account.', 404);
	const [a] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	const [accountPresent, storePresent] = await Promise.all([
		sfExisting('Account', [a?.sfdc_account_id]),
		sfExisting('Store__c', [s.sfdc_store_id])
	]);
	if (accountPresent === null || storePresent === null) throw new ActionError('Salesforce is unreachable right now. Try again shortly.', 502);
	const ctx = { accountId, localStoreId: s.id };
	const fields = {
		name: s.name, sfdcAccountId: a?.sfdc_account_id ?? null, marketplaces: s.marketplaces, sellerId: s.seller_id,
		sellerPrimaryEmail: s.seller_primary_email, storeEmail: s.store_email, businessName: s.business_name,
		country: s.country, description: s.description
	};

	requireMode(mode, sfState(s.sfdc_store_id, storePresent) === 'synced', 'store');
	if (mode === 'update') {
		const r = await updateSalesforceStore(s.sfdc_store_id!, fields, ctx);
		if (!r.ok) throw new ActionError(r.error, 502);
		return 'Store already in Salesforce — current values pushed.';
	}
	if (sfState(a?.sfdc_account_id, accountPresent) !== 'synced') {
		throw new ActionError('The account is not in Salesforce. Re-sync the account first.', 409);
	}
	const res = await createSalesforceStore(fields, ctx);
	if (!res.ok) throw new ActionError(res.error, 502);
	await sql`UPDATE stores SET sfdc_store_id = ${res.sfdcStoreId} WHERE id = ${s.id}`;
	return s.sfdc_store_id ? 'Store was missing in Salesforce — recreated and relinked.' : 'Store created in Salesforce.';
}

/**
 * Contract sync.
 *  update — push payment status / dates (and "Cancelled") to the existing ServiceContract.
 *  create — build the ServiceContract + line items in Salesforce from the local purchase record
 *           (same call the checkout uses), for purchases whose first sync failed. A cancelled
 *           or stale link is replaced by the new id.
 */
async function resyncContract(accountId: string, contractId: string, mode: SyncMode): Promise<string> {
	const [c] = await sql<ContractRowFull[]>`SELECT id, kind, user_id, store_id, status, payment_status, start_date, end_date, term_months, sfdc_service_contract_id, sfdc_pricebook2_id,
	         stripe_payment_intent_id, stripe_charge_id, stripe_receipt_email, stripe_payment_method_id, stripe_payment_method_type,
	         amount_cents::text AS amount_cents, currency
	  FROM service_contracts WHERE id = ${contractId} AND account_id = ${accountId}`;
	if (!c) throw new ActionError('Contract not found on this account.', 404);
	const existing = await sfExisting('ServiceContract', [c.sfdc_service_contract_id]);
	if (existing === null) throw new ActionError('Salesforce is unreachable right now. Try again shortly.', 502);
	const present = sfState(c.sfdc_service_contract_id, existing) === 'synced';
	requireMode(mode, present, 'contract');
	if (mode === 'repair') return repairContract(accountId, c);

	if (mode === 'update') {
		const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
		const body: Record<string, unknown> = { Payment_Status__c: c.payment_status, StartDate: date(c.start_date), EndDate: date(c.end_date) };
		if ((c.status ?? '').toLowerCase() === 'cancelled') body.Status = 'Cancelled';
		try {
			await sobjectUpdate('ServiceContract', c.sfdc_service_contract_id!, body);
		} catch (e) {
			throw new ActionError(e instanceof Error ? e.message : String(e), 502);
		}
		return 'Contract already in Salesforce — current values pushed.';
	}

	// ── create ──
	const input = await contractInput(accountId, c);
	const res = await createServiceContractWithLines(input, { accountId });
	if (!res.ok) {
		await sql`UPDATE service_contracts SET sync_status = 'failed', sync_error = ${res.error} WHERE id = ${c.id}`;
		throw new ActionError(res.error, 502);
	}
	await sql.begin(async (tx) => {
		await tx`UPDATE service_contracts SET sfdc_service_contract_id = ${res.sfdcServiceContractId}, sync_status = 'synced', sync_error = NULL, synced_at = now() WHERE id = ${c.id}`;
		const rows = await tx<{ id: string }[]>`SELECT id FROM service_contract_line_items WHERE service_contract_id = ${c.id} ORDER BY seq NULLS LAST, created_at`;
		for (let i = 0; i < rows.length; i++) {
			if (res.lineItemIds[i]) await tx`UPDATE service_contract_line_items SET sfdc_contract_line_item_id = ${res.lineItemIds[i]} WHERE id = ${rows[i].id}`;
		}
	});
	return c.sfdc_service_contract_id
		? 'Contract was missing in Salesforce — recreated with its line items and relinked.'
		: 'Contract created in Salesforce with its line items.';
}

/** Build the Salesforce ServiceContractInput for a local contract (same data checkout used). */
async function contractInput(accountId: string, c: ContractRowFull): Promise<ServiceContractInput> {
	const [acct] = await sql<{ name: string; sfdc_account_id: string | null }[]>`SELECT name, sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	if (!acct?.sfdc_account_id) throw new ActionError('The account is not in Salesforce. Create the account first.', 409);
	if (!c.sfdc_pricebook2_id) throw new ActionError('This contract has no price book recorded, so it cannot be rebuilt in Salesforce.', 422);
	const lines = await sql<{ product_name: string; unit_price: string; quantity: number; sfdc_pricebook_entry_id: string | null; balance_due: string; month_index: number | null; payment_due_date: Date | null }[]>`
		SELECT product_name, unit_price, quantity, sfdc_pricebook_entry_id, balance_due, month_index, payment_due_date FROM service_contract_line_items
		WHERE service_contract_id = ${c.id} ORDER BY seq NULLS LAST, created_at`;
	if (!lines.length) throw new ActionError('This contract has no line items to create in Salesforce.', 422);
	if (lines.some((l) => !l.sfdc_pricebook_entry_id)) throw new ActionError('A line item has no Salesforce price book entry recorded, so the contract cannot be rebuilt.', 422);
	const [owner] = c.user_id ? await sql<{ sfdc_contact_id: string | null }[]>`SELECT sfdc_contact_id FROM users WHERE id = ${c.user_id}` : [];
	const [store] = c.store_id
		? await sql<{ name: string; sfdc_store_id: string | null; poc: string | null }[]>`
			SELECT s.name, s.sfdc_store_id, ac.sfdc_contact_id AS poc FROM stores s
			LEFT JOIN account_contacts ac ON ac.id = s.point_of_contact_id WHERE s.id = ${c.store_id}`
		: [];
	const kind = c.kind === 'subscription' ? 'subscription' : c.kind === 'recurring' ? 'recurring' : 'service';
	// Recurring pay-by-month: a line with a later month still owing is a 'due' instalment; month 1 is the paid one.
	const monthly = kind === 'recurring' && lines.some((l) => l.month_index != null && Number(l.balance_due) > 0);
	return {
		name: `${(store?.name ?? acct.name).trim()} ${c.start_date.toISOString().slice(0, 10)} ${kind === 'subscription' ? 'Subscription' : kind === 'recurring' ? 'Recurring Services' : 'Services'}`,
		kind, sfdcAccountId: acct.sfdc_account_id, sfdcContactId: owner?.sfdc_contact_id ?? null, sfdcStoreId: store?.sfdc_store_id ?? null,
		sfdcPricebook2Id: c.sfdc_pricebook2_id, startDate: c.start_date, termMonths: c.term_months,
		stripe: {
			paymentIntentId: c.stripe_payment_intent_id, chargeId: c.stripe_charge_id, amount: Number(c.amount_cents) / 100, currency: c.currency.toUpperCase(),
			receiptEmail: c.stripe_receipt_email, paymentMethodId: c.stripe_payment_method_id, paymentMethodType: c.stripe_payment_method_type
		},
		lineItems: lines.map((l) => ({
			pricebookEntryId: l.sfdc_pricebook_entry_id!, quantity: l.quantity, unitPrice: Number(l.unit_price), name: l.product_name,
			...(l.month_index != null
				? {
					description: recurringMonthDescription(l.month_index, c.term_months, c.start_date), monthIndex: l.month_index, skipCase: l.month_index > 1,
					...(l.month_index === 1 ? { caseCount: Math.max(1, Math.floor(l.quantity)) } : {}),
					...(monthly ? { installment: { status: (l.month_index === 1 ? 'paid' : 'due') as 'paid' | 'due', dueDate: l.payment_due_date ?? addMonthsClamped(c.start_date, l.month_index - 1) } } : {})
				}
				: { balanceDue: Number(l.balance_due) })
		})),
		sfdcStoreContactId: store?.poc ?? null, localContractId: c.id,
		paymentStatus: c.payment_status ?? (kind === 'subscription' ? 'Subscription' : 'Paid')
	};
}

interface ContractRowFull {
	id: string; kind: string; user_id: string | null; store_id: string | null; status: string | null; payment_status: string | null;
	start_date: Date; end_date: Date; term_months: number; sfdc_service_contract_id: string | null; sfdc_pricebook2_id: string | null;
	stripe_payment_intent_id: string; stripe_charge_id: string | null; stripe_receipt_email: string | null;
	stripe_payment_method_id: string | null; stripe_payment_method_type: string | null; amount_cents: string; currency: string;
}

/** Create only the line items, cases and payments a partly-built Salesforce contract is missing. */
async function repairContract(accountId: string, c: ContractRowFull): Promise<string> {
	const input = await contractInput(accountId, c);
	const sfId = c.sfdc_service_contract_id!;
	const [slines, cases] = await Promise.all([
		sfdcQuery<{ Id: string; PricebookEntryId: string }>(`SELECT Id, PricebookEntryId FROM ContractLineItem WHERE ServiceContractId = '${sfId}' ORDER BY CreatedDate`),
		sfdcQuery<{ Id: string; Contract_Line_Item__c: string | null }>(`SELECT Id, Contract_Line_Item__c FROM Case WHERE Contract__c = '${sfId}'`)
	]);
	// Match local lines to the Salesforce line items that already exist (by price book entry, in order).
	const pool = [...slines.records];
	const lineItemIds = input.lineItems.map((li) => {
		const i = pool.findIndex((x) => x.PricebookEntryId === li.pricebookEntryId);
		return i >= 0 ? pool.splice(i, 1)[0].Id : '';
	});
	const caseByLine = new Map(cases.records.filter((x) => x.Contract_Line_Item__c).map((x) => [x.Contract_Line_Item__c!, x.Id]));
	const caseCountByLine = new Map<string, number>();
	for (const x of cases.records) if (x.Contract_Line_Item__c) caseCountByLine.set(x.Contract_Line_Item__c, (caseCountByLine.get(x.Contract_Line_Item__c) ?? 0) + 1);
	const out = await populateContract(
		sfId,
		input,
		{
			lineItemIds,
			caseByLine,
			caseCountByLine,
			anyCaseId: cases.records[0]?.Id ?? null
		},
		{ accountId },
		'delete' // an admin asked for this repair: remove the redundant auto-generated pending payments
	);
	// Remember the new Salesforce line item ids locally.
	const rows = await sql<{ id: string }[]>`SELECT id FROM service_contract_line_items WHERE service_contract_id = ${c.id} ORDER BY seq NULLS LAST, created_at`;
	for (let i = 0; i < rows.length; i++) {
		if (out.lineItemIds[i]) await sql`UPDATE service_contract_line_items SET sfdc_contract_line_item_id = ${out.lineItemIds[i]} WHERE id = ${rows[i].id}`;
	}
	const { lines, cases: nc, payments } = out.created;
	const rec = out.reconciled.removed + out.reconciled.cancelled;
	const recText = rec ? ` Removed ${out.reconciled.removed} and cancelled ${out.reconciled.cancelled} redundant pending payment${rec === 1 ? '' : 's'} that duplicated the checkout payment.` : '';
	if (!lines && !nc && !payments) return rec ? `Nothing was missing.${recText}` : 'Nothing was missing — the contract already has its line items, cases and payments in Salesforce.';
	const failed = out.lineItemIds.filter((x) => !x).length;
	return `Completed in Salesforce: ${lines} line item${lines === 1 ? '' : 's'}, ${nc} case${nc === 1 ? '' : 's'}, ${payments} payment${payments === 1 ? '' : 's'} created.` + recText + (failed ? ` ${failed} line item(s) still could not be created — check the error log.` : '');
}
