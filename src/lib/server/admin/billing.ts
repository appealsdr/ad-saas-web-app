/**
 * Admin billing read model: contracts (with line items) and their payments.
 *
 * Contracts and line items are local rows. Payments are Salesforce Payment__c
 * records linked to each contract (a contract-level First Payment plus one per
 * line when a Deposit product is involved). A contract with no Salesforce
 * payment records — or when Salesforce can't be queried — gets one synthetic
 * "Paid in full" payment from the Stripe charge that created it.
 */
import { sql } from '../db';
import { sfdcQuery } from '../salesforce/client';
import { logError } from '../error_log';

export type PayStatus = 'paid' | 'due' | 'failed' | 'closed' | 'inactive' | 'ready';

export interface AdminLine { name: string; category: string | null; description: string | null; qty: number; unit: number; sfdcLineId: string | null }
export interface AdminPayment {
	key: string; // Salesforce Id, or `local:<contractId>` for a synthetic payment
	sfId: string | null;
	name: string;
	contractId: string;
	contractRef: string;
	storeName: string | null;
	kind: string;
	amount: number;
	status: PayStatus;
	statusRaw: string;
	date: string;
	stripePi: string | null;
	isLine: boolean;
}
export interface AdminContract {
	id: string; ref: string; kind: string; status: string | null; paymentStatus: string | null; storeId: string | null; storeName: string | null;
	currency: string; amount: number; paidAt: string | null; startDate: string | null; endDate: string | null; termMonths: number | null;
	sfdcId: string | null; syncStatus: string | null; stripePi: string | null; stripeSub: string | null;
	lines: AdminLine[]; payments: AdminPayment[];
}

interface SfPayment {
	Id: string; Name: string; Amount__c: number | null; Status__c: string | null; Payment_Type__c: string | null; PaidAt__c: string | null;
	Description__c: string | null; CreatedDate: string; Stripe_Payment_Intent_Id__c: string | null; Service_Contract__c: string | null; Contract_Line_Item__c: string | null;
}

export const PAYMENT_FIELDS = `Id, Name, Amount__c, Total_Paid__c, Status__c, Payment_Type__c, PaidAt__c, Description__c, CreatedDate, LastModifiedDate,
	Stripe_Payment_Intent_Id__c, Stripe_Checkout_Session_Id__c, Payment_Method__c, Service_Contract__c, Contract_Line_Item__c`;

export const mapPayStatus = (s: string | null, isBalance = false): PayStatus => {
	switch ((s ?? '').toLowerCase()) {
		case 'request payment': return 'ready';
		case 'not active': return 'inactive';
		case 'paid': return 'paid';
		case 'failed': return 'failed';
		case 'cancelled': case 'refunded': return 'closed';
		default: return isBalance && (s ?? '').toLowerCase() === 'pending' ? 'inactive' : 'due';
	}
};

export async function accountContracts(accountId: string, opts: { storeId?: string } = {}): Promise<{ contracts: AdminContract[]; paymentsError: string | null }> {
	const storeId = opts.storeId ?? null;
	const [rows, lines] = await Promise.all([
		sql<{
			id: string; kind: string; status: string | null; payment_status: string | null; store_id: string | null; store_name: string | null;
			currency: string; amount_cents: string; paid_at: Date | null; start_date: Date | null; end_date: Date | null; term_months: number | null;
			sfdc_service_contract_id: string | null; sync_status: string | null; stripe_payment_intent_id: string | null; stripe_subscription_id: string | null;
		}[]>`
			SELECT c.id, c.kind, c.status, c.payment_status, c.store_id, s.name AS store_name, c.currency, c.amount_cents::text AS amount_cents,
			       c.paid_at, c.start_date, c.end_date, c.term_months, c.sfdc_service_contract_id, c.sync_status,
			       c.stripe_payment_intent_id, c.stripe_subscription_id
			FROM service_contracts c LEFT JOIN stores s ON s.id = c.store_id AND s.account_id = c.account_id
			WHERE c.account_id = ${accountId} AND (${storeId}::uuid IS NULL OR c.store_id = ${storeId}) ORDER BY c.created_at DESC, c.id`,
		sql<{ service_contract_id: string; product_name: string; product_category: string | null; product_description: string | null; quantity: number; unit_price: string; sfdc_contract_line_item_id: string | null }[]>`
			SELECT l.service_contract_id, l.product_name, l.product_category, l.product_description, l.quantity, l.unit_price, l.sfdc_contract_line_item_id
			FROM service_contract_line_items l JOIN service_contracts c ON c.id = l.service_contract_id
			WHERE c.account_id = ${accountId} AND (${storeId}::uuid IS NULL OR c.store_id = ${storeId}) ORDER BY l.created_at`
	]);

	const sfIds = rows.map((r) => r.sfdc_service_contract_id).filter((x): x is string => !!x);
	let sf: SfPayment[] = [];
	let paymentsError: string | null = null;
	try {
		for (let i = 0; i < sfIds.length; i += 150) {
			const list = sfIds.slice(i, i + 150).map((x) => `'${x.replace(/'/g, '')}'`).join(',');
			const r = await sfdcQuery<SfPayment>(`SELECT ${PAYMENT_FIELDS} FROM Payment__c WHERE Service_Contract__c IN (${list}) ORDER BY CreatedDate ASC`, { paginate: true });
			sf.push(...r.records);
		}
	} catch (e) {
		paymentsError = e instanceof Error ? e.message : String(e);
		sf = [];
		await logError({ source: 'admin.billing', operation: 'fetch_sf_payments', accountId, errorMessage: paymentsError });
	}

	const ref = (id: string) => `SC-${id.slice(0, 8).toUpperCase()}`;
	const contracts = rows.map((r): AdminContract => {
		const payments: AdminPayment[] = sf
			.filter((p) => p.Service_Contract__c === r.sfdc_service_contract_id)
			.map((p) => ({
				key: p.Id, sfId: p.Id, name: p.Name || p.Id, contractId: r.id, contractRef: ref(r.id), storeName: r.store_name,
				kind: p.Payment_Type__c === 'Balance' ? `Balance${p.Description__c ? ` · ${p.Description__c}` : ''}` : p.Contract_Line_Item__c ? `Line payment${p.Description__c ? ` · ${p.Description__c}` : ''}` : p.Payment_Type__c || 'First Payment',
				amount: Number(p.Amount__c ?? 0), status: mapPayStatus(p.Status__c, p.Payment_Type__c === 'Balance'), statusRaw: p.Status__c ?? 'Pending',
				date: (p.PaidAt__c || p.CreatedDate).slice(0, 10), stripePi: p.Stripe_Payment_Intent_Id__c, isLine: !!p.Contract_Line_Item__c && p.Payment_Type__c !== 'Balance'
			}));
		if (!payments.length) {
			payments.push({
				key: `local:${r.id}`, sfId: null, name: `PAY-${r.id.slice(0, 8).toUpperCase()}`, contractId: r.id, contractRef: ref(r.id), storeName: r.store_name,
				kind: r.kind === 'subscription' ? 'Subscription' : 'Paid in full', amount: Number(r.amount_cents) / 100, status: 'paid', statusRaw: 'Paid',
				date: (r.paid_at ?? new Date()).toISOString().slice(0, 10), stripePi: r.stripe_payment_intent_id, isLine: false
			});
		}
		return {
			id: r.id, ref: ref(r.id), kind: r.kind, status: r.status, paymentStatus: r.payment_status, storeId: r.store_id, storeName: r.store_name,
			currency: r.currency, amount: Number(r.amount_cents) / 100, paidAt: r.paid_at?.toISOString() ?? null,
			startDate: r.start_date?.toISOString().slice(0, 10) ?? null, endDate: r.end_date?.toISOString().slice(0, 10) ?? null,
			termMonths: r.term_months, sfdcId: r.sfdc_service_contract_id, syncStatus: r.sync_status, stripePi: r.stripe_payment_intent_id, stripeSub: r.stripe_subscription_id,
			lines: lines.filter((l) => l.service_contract_id === r.id).map((l) => ({ name: l.product_name, category: l.product_category, description: l.product_description, qty: l.quantity, unit: Number(l.unit_price), sfdcLineId: l.sfdc_contract_line_item_id })),
			payments
		};
	});
	return { contracts, paymentsError };
}
