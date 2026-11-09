/**
 * Payments page: invoices (individual payments) and the service contracts
 * they belong to.
 *
 * Contracts + line items come from Postgres. Payments come from Salesforce
 * Payment__c records linked to each contract (a contract-level "First Payment"
 * plus one payment per line when any line is a Deposit). Contracts with no
 * Salesforce payment records — or when Salesforce is unreachable — get one
 * synthetic "Paid in full" payment from the Stripe charge that created them.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { sfdcQuery } from '$lib/server/salesforce';
import { logError } from '$lib/server/error_log';

interface ContractRow {
	id: string;
	stripe_payment_intent_id: string;
	amount_cents: bigint;
	currency: string;
	paid_at: Date;
	start_date: Date;
	end_date: Date;
	term_months: number;
	kind: string;
	sfdc_service_contract_id: string | null;
	sync_status: string;
	store_id: string | null;
	store_name: string | null;
}

interface LineRow {
	service_contract_id: string;
	product_name: string;
	product_description: string | null;
	product_category: string | null;
	unit_price: string;
	quantity: number;
}

interface SfPayment {
	Id: string;
	Name: string;
	Amount__c: number | null;
	Status__c: string | null;
	Payment_Type__c: string | null;
	PaidAt__c: string | null;
	Payment_Date__c: string | null;
	Description__c: string | null;
	CreatedDate: string;
	Stripe_Payment_Intent_Id__c: string | null;
	Service_Contract__c: string | null;
	Contract_Line_Item__c: string | null;
}

export type PayStatus = 'paid' | 'action' | 'due' | 'closed' | 'inactive' | 'ready';

function mapStatus(s: string | null, isBalance = false): PayStatus {
	switch ((s ?? '').toLowerCase()) {
		case 'request payment':
			return 'ready';
		case 'not active':
			return 'inactive';
		case 'paid':
			return 'paid';
		case 'failed':
			return 'action';
		case 'cancelled':
		case 'refunded':
			return 'closed';
		default:
			// A Pending balance (created before 'Not Active' existed) is not collectible yet either.
			return isBalance && (s ?? '').toLowerCase() === 'pending' ? 'inactive' : 'due'; // Pending / Processing
	}
}

async function fetchSfPayments(sfdcContractIds: string[]): Promise<SfPayment[]> {
	const out: SfPayment[] = [];
	for (let i = 0; i < sfdcContractIds.length; i += 150) {
		const ids = sfdcContractIds.slice(i, i + 150).map((id) => `'${id.replace(/'/g, '')}'`).join(',');
		const res = await sfdcQuery<SfPayment>(
			`SELECT Id, Name, Amount__c, Status__c, Payment_Type__c, PaidAt__c, Payment_Date__c, Description__c, CreatedDate,
			        Stripe_Payment_Intent_Id__c, Service_Contract__c, Contract_Line_Item__c
			 FROM Payment__c WHERE Service_Contract__c IN (${ids}) ORDER BY CreatedDate ASC`,
			{ paginate: true }
		);
		out.push(...res.records);
	}
	return out;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const empty = {
		accountName: null as string | null,
		receiptEmail: locals.user.email as string | null,
		contracts: [] as ReturnType<typeof shapeContract>[],
		payments: [] as PaymentOut[],
		paymentsError: null as string | null
	};

	const [user] = await sql<{ account_id: string | null; email: string }[]>`
		SELECT account_id, email FROM users WHERE id = ${locals.user.id} LIMIT 1
	`;
	if (!user?.account_id) return empty;

	const [[acct], rows, lines] = await Promise.all([
		sql<{ name: string }[]>`SELECT name FROM accounts WHERE id = ${user.account_id}`,
		sql<ContractRow[]>`
			SELECT c.id, c.stripe_payment_intent_id, c.amount_cents, c.currency, c.paid_at,
			       c.start_date, c.end_date, c.term_months, c.kind,
			       c.sfdc_service_contract_id, c.sync_status, c.store_id, s.name AS store_name
			FROM service_contracts c LEFT JOIN stores s ON s.id = c.store_id
			WHERE c.account_id = ${user.account_id}
			ORDER BY c.paid_at DESC
		`,
		sql<LineRow[]>`
			SELECT l.service_contract_id, l.product_name, l.product_description, l.product_category,
			       l.unit_price, l.quantity
			FROM service_contract_line_items l
			JOIN service_contracts c ON c.id = l.service_contract_id
			WHERE c.account_id = ${user.account_id}
			ORDER BY l.created_at ASC
		`
	]);

	const linesBy = new Map<string, LineRow[]>();
	for (const l of lines) linesBy.set(l.service_contract_id, [...(linesBy.get(l.service_contract_id) ?? []), l]);

	// Salesforce payments, best-effort.
	let sfPayments: SfPayment[] = [];
	let paymentsError: string | null = null;
	const sfIds = rows.map((r) => r.sfdc_service_contract_id).filter((x): x is string => !!x);
	if (sfIds.length) {
		try {
			sfPayments = await fetchSfPayments(sfIds);
		} catch (e) {
			paymentsError = e instanceof Error ? e.message : String(e);
			await logError({
				source: 'payments.list',
				operation: 'fetch_sf_payments',
				userId: locals.user.id,
				accountId: user.account_id,
				errorMessage: paymentsError
			});
		}
	}

	const localByCtr = new Map(rows.map((r) => [r.sfdc_service_contract_id, r]));
	const payments: PaymentOut[] = [];
	for (const p of sfPayments) {
		const c = p.Service_Contract__c ? localByCtr.get(p.Service_Contract__c) : null;
		if (!c) continue;
		const isBalance = p.Payment_Type__c === 'Balance';
		// A Balance is its own payment (the rest of a deposit service). Other line payments are
		// components of the contract's First Payment.
		const isLine = !!p.Contract_Line_Item__c && !isBalance;
		payments.push({
			id: p.Name || p.Id,
			sfId: p.Id,
			contractId: c.id,
			kind: isBalance ? 'Balance' : isLine ? `Line payment${p.Description__c ? ` · ${p.Description__c}` : ''}` : p.Payment_Type__c === 'Service Contract' ? 'Paid at checkout' : (p.Payment_Type__c || 'First Payment'),
			deferred: isBalance && mapStatus(p.Status__c, true) === 'inactive',
			detail: isBalance ? (p.Description__c ?? null) : null,
			amount: Number(p.Amount__c ?? 0),
			status: mapStatus(p.Status__c, isBalance),
			statusRaw: p.Status__c ?? 'Pending',
			// Paid → when it was paid; not paid yet → its Payment_Date__c (the due date); else when the record was created.
			date: (p.PaidAt__c || p.Payment_Date__c || p.CreatedDate).slice(0, 10),
			pi: p.Stripe_Payment_Intent_Id__c,
			isLine
		});
	}
	// Fallback: contracts without any Salesforce payment get their Stripe charge.
	const covered = new Set(payments.map((p) => p.contractId));
	for (const c of rows) {
		if (covered.has(c.id)) continue;
		payments.push({
			id: `PAY-${c.id.slice(0, 8).toUpperCase()}`,
			sfId: null,
			contractId: c.id,
			kind: c.kind === 'subscription' ? 'Subscription' : 'Paid in full',
			amount: Number(c.amount_cents) / 100,
			status: 'paid',
			statusRaw: 'Paid',
			date: c.paid_at.toISOString().slice(0, 10),
			pi: c.stripe_payment_intent_id,
			isLine: false
		});
	}

	return {
		accountName: (acct?.name ?? null) as string | null,
		receiptEmail: user.email as string | null,
		contracts: rows.map((r) => shapeContract(r, linesBy.get(r.id) ?? [])),
		payments,
		paymentsError
	};
};

export interface PaymentOut {
	id: string;
	sfId: string | null;
	contractId: string;
	kind: string;
	amount: number;
	status: PayStatus;
	statusRaw: string;
	date: string;
	pi: string | null;
	isLine: boolean;
	/** The balance of a deposit service, collected separately when its case is completed. */
	deferred?: boolean;
	detail?: string | null;
}

function shapeContract(r: ContractRow, lines: LineRow[]) {
	return {
		id: r.id,
		ref: `SC-${r.id.slice(0, 8).toUpperCase()}`,
		kind: r.kind,
		storeId: r.store_id,
		storeName: r.store_name,
		currency: r.currency,
		amount: Number(r.amount_cents) / 100,
		paidAt: r.paid_at.toISOString(),
		startDate: r.start_date.toISOString().slice(0, 10),
		endDate: r.end_date.toISOString().slice(0, 10),
		termMonths: r.term_months,
		sfdcServiceContractId: r.sfdc_service_contract_id,
		syncStatus: r.sync_status,
		stripePaymentIntentId: r.stripe_payment_intent_id,
		lines: lines.map((l) => ({
			name: l.product_name,
			desc: l.product_description,
			category: l.product_category,
			qty: l.quantity,
			unit: Number(l.unit_price)
		}))
	};
}
