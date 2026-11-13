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

/** Salesforce ServiceContract.Name by Id (best-effort) — the contract's real name, e.g. "<Store> <date> Recurring Services". */
async function fetchSfContractNames(sfdcContractIds: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (let i = 0; i < sfdcContractIds.length; i += 150) {
		const ids = sfdcContractIds.slice(i, i + 150).map((id) => `'${id.replace(/'/g, '')}'`).join(',');
		const res = await sfdcQuery<{ Id: string; Name: string | null }>(`SELECT Id, Name FROM ServiceContract WHERE Id IN (${ids})`, { paginate: true });
		for (const r of res.records) if (r.Name) out.set(r.Id, r.Name);
	}
	return out;
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

	// Contracts that exist only in Salesforce (linked via a sign-up link): shown in the same UI, keyed by their SF id.
	const [acctRow] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${user.account_id}`;
	const sfOnly = await loadSalesforceOnlyContracts(acctRow?.sfdc_account_id ?? null, new Set(rows.map((r) => r.sfdc_service_contract_id).filter((x): x is string => !!x)));
	rows.push(...sfOnly.rows);
	lines.push(...sfOnly.lines);

	const linesBy = new Map<string, LineRow[]>();
	for (const l of lines) linesBy.set(l.service_contract_id, [...(linesBy.get(l.service_contract_id) ?? []), l]);

	// Salesforce payments, best-effort.
	let sfPayments: SfPayment[] = [];
	let paymentsError: string | null = null;
	let sfNames = new Map<string, string>();
	const sfIds = rows.map((r) => r.sfdc_service_contract_id).filter((x): x is string => !!x);
	if (sfIds.length) {
		try {
			sfNames = await fetchSfContractNames(sfIds).catch(() => new Map<string, string>());
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
		if (covered.has(c.id) || !c.stripe_payment_intent_id) continue; // Salesforce-only contracts have no Stripe charge to fall back on
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
		contracts: rows.map((r) => shapeContract(r, linesBy.get(r.id) ?? [], r.sfdc_service_contract_id ? sfNames.get(r.sfdc_service_contract_id) ?? null : null)),
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

function shapeContract(r: ContractRow, lines: LineRow[], sfName: string | null) {
	return {
		id: r.id,
		/** Salesforce ServiceContract.Name (null when not synced / unavailable). */
		name: sfName,
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

/** ServiceContracts of the linked Salesforce Account that have no local mirror row, shaped like local ones. */
async function loadSalesforceOnlyContracts(sfdcAccountId: string | null, known: Set<string>): Promise<{ rows: ContractRow[]; lines: LineRow[] }> {
	const none = { rows: [] as ContractRow[], lines: [] as LineRow[] };
	if (!sfdcAccountId || !/^[a-zA-Z0-9]{15,18}$/.test(sfdcAccountId)) return none;
	try {
		type C = { Id: string; StartDate: string | null; EndDate: string | null; CreatedDate: string; Store__r?: { Name: string } | null };
		let cs: C[];
		try {
			cs = (await sfdcQuery<C>(`SELECT Id, StartDate, EndDate, CreatedDate, Store__r.Name FROM ServiceContract WHERE AccountId = '${sfdcAccountId}' ORDER BY CreatedDate DESC LIMIT 200`, { paginate: true })).records;
		} catch {
			cs = (await sfdcQuery<C>(`SELECT Id, StartDate, EndDate, CreatedDate FROM ServiceContract WHERE AccountId = '${sfdcAccountId}' ORDER BY CreatedDate DESC LIMIT 200`, { paginate: true })).records;
		}
		cs = cs.filter((c) => !known.has(c.Id));
		if (!cs.length) return none;
		const inList = cs.map((c) => `'${c.Id}'`).join(',');
		type L = { ServiceContractId: string; Quantity: number | null; UnitPrice: number | null; Description: string | null; PricebookEntry?: { Product2?: { Name: string } | null } | null };
		const ls = (await sfdcQuery<L>(`SELECT ServiceContractId, Quantity, UnitPrice, Description, PricebookEntry.Product2.Name FROM ContractLineItem WHERE ServiceContractId IN (${inList}) ORDER BY CreatedDate ASC`, { paginate: true })).records;
		const rows: ContractRow[] = cs.map((c) => {
			const start = new Date((c.StartDate ?? c.CreatedDate.slice(0, 10)) + 'T00:00:00Z');
			const end = new Date((c.EndDate ?? c.StartDate ?? c.CreatedDate.slice(0, 10)) + 'T00:00:00Z');
			return {
				id: c.Id, stripe_payment_intent_id: '', amount_cents: 0n, currency: 'usd', paid_at: new Date(c.CreatedDate),
				start_date: start, end_date: end, term_months: Math.max(1, Math.round((end.getTime() - start.getTime()) / (30.44 * 864e5))),
				kind: 'service', sfdc_service_contract_id: c.Id, sync_status: 'synced', store_id: null, store_name: c.Store__r?.Name ?? null
			};
		});
		const lines: LineRow[] = ls.map((l) => ({
			service_contract_id: l.ServiceContractId, product_name: l.PricebookEntry?.Product2?.Name ?? 'Service', product_description: l.Description,
			product_category: null, unit_price: String(l.UnitPrice ?? 0), quantity: Number(l.Quantity ?? 1)
		}));
		return { rows, lines };
	} catch {
		return none; // best-effort: never break the Payments page
	}
}
