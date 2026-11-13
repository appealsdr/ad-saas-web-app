/**
 * Outstanding payments for the dashboard (AD-1934).
 *
 * Reads the account's ServiceContracts and their unpaid Payment__c records straight from Salesforce, so
 * contracts that exist only in Salesforce (linked via a sign-up link) show up too — no local
 * service_contracts row needed. Collectibility is still enforced at pay time (balance.ts).
 */
import { sfdcQuery } from '../salesforce/client';
import { isSfId, STATUS_REQUEST } from './balance';

export interface OutstandingPayment {
	id: string;
	name: string;
	description: string | null;
	amount: number;
	status: string;
	/** Only 'Request Payment' can be paid right now. */
	payable: boolean;
	dueDate: string | null;
}
export interface OutstandingContract {
	id: string;
	name: string;
	number: string | null;
	startDate: string | null;
	endDate: string | null;
	totalDue: number;
	payments: OutstandingPayment[];
	/** Contract overview page (what is being paid). */
	payHref: string;
	firstPayableId: string | null;
}

// Only ACTIVE payments (collectible now). Pending / Not Active / Failed ones are not shown on the dashboard.
const UNPAID = [STATUS_REQUEST];

export async function listOutstandingContracts(sfdcAccountId: string | null): Promise<OutstandingContract[]> {
	if (!sfdcAccountId || !isSfId(sfdcAccountId)) return [];
	const contracts = await sfdcQuery<{ Id: string; Name: string | null; ContractNumber: string | null; StartDate: string | null; EndDate: string | null }>(
		`SELECT Id, Name, ContractNumber, StartDate, EndDate FROM ServiceContract WHERE AccountId = '${sfdcAccountId}' ORDER BY CreatedDate DESC LIMIT 200`,
		{ paginate: true }
	);
	if (!contracts.records.length) return [];
	const ids = contracts.records.map((c) => `'${c.Id}'`).join(',');
	const pays = await sfdcQuery<{
		Id: string; Name: string; Amount__c: number | null; Status__c: string | null; Description__c: string | null;
		Payment_Date__c: string | null; Service_Contract__c: string; Payment_Type__c: string | null; Contract_Line_Item__c: string | null;
	}>(
		`SELECT Id, Name, Amount__c, Status__c, Description__c, Payment_Date__c, Service_Contract__c, Payment_Type__c, Contract_Line_Item__c
		 FROM Payment__c WHERE Service_Contract__c IN (${ids}) AND Status__c IN (${UNPAID.map((s) => `'${s}'`).join(',')})
		 ORDER BY Payment_Date__c ASC NULLS LAST, CreatedDate ASC`,
		{ paginate: true }
	);
	const out: OutstandingContract[] = [];
	for (const c of contracts.records) {
		const payments = pays.records
			.filter((p) => p.Service_Contract__c === c.Id && (p.Amount__c ?? 0) > 0)
			// A line-level payment is a component of the contract's First Payment unless it is the deposit balance.
			.filter((p) => !p.Contract_Line_Item__c || p.Payment_Type__c === 'Balance' || !pays.records.some((q) => q.Service_Contract__c === c.Id && !q.Contract_Line_Item__c))
			.map((p) => ({
				id: p.Id,
				name: p.Name,
				description: p.Description__c,
				amount: Number(p.Amount__c),
				status: p.Status__c ?? 'Pending',
				payable: p.Status__c === STATUS_REQUEST,
				dueDate: p.Payment_Date__c
			}));
		if (!payments.length) continue;
		const firstPayable = payments.find((p) => p.payable);
		out.push({
			id: c.Id,
			name: c.Name ?? c.ContractNumber ?? 'Service contract',
			number: c.ContractNumber,
			startDate: c.StartDate,
			endDate: c.EndDate,
			totalDue: payments.reduce((n, p) => n + p.amount, 0),
			payments,
			payHref: `/payments/contract/${c.Id}`,
			firstPayableId: firstPayable?.id ?? null
		});
	}
	return out;
}
