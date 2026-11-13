/**
 * Full overview of one Salesforce ServiceContract for the client: contract info, line items and every payment.
 * Tenancy: the contract must belong to the account (ServiceContract.AccountId = the account's linked Salesforce
 * Account, or a local service_contracts mirror row).
 */
import { sql } from '../db';
import { sfdcQuery } from '../salesforce/client';
import { isSfId, STATUS_REQUEST } from './balance';

export interface ContractOverview {
	id: string;
	name: string;
	number: string | null;
	startDate: string | null;
	endDate: string | null;
	storeName: string | null;
	currency: string;
	lines: { id: string; name: string; description: string | null; quantity: number; unitPrice: number; total: number; deposit: number | null }[];
	payments: { id: string; name: string; description: string | null; type: string | null; amount: number; status: string; payable: boolean; date: string | null }[];
	totals: { contract: number; paid: number; due: number };
}

async function tryQuery<T>(soql: string, fallback: string): Promise<T[]> {
	try { return (await sfdcQuery<T>(soql, { paginate: true })).records; }
	catch { return (await sfdcQuery<T>(fallback, { paginate: true })).records; }
}

export async function getContractOverview(accountId: string, contractId: string): Promise<ContractOverview | null> {
	if (!isSfId(contractId)) return null;
	const [acct] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${accountId}`;
	const [local] = await sql<{ currency: string }[]>`SELECT currency FROM service_contracts WHERE account_id = ${accountId} AND sfdc_service_contract_id = ${contractId} LIMIT 1`;
	if (!local && (!acct?.sfdc_account_id || !isSfId(acct.sfdc_account_id))) return null;

	const base = `FROM ServiceContract WHERE Id = '${contractId}'${local ? '' : ` AND AccountId = '${acct!.sfdc_account_id}'`} LIMIT 1`;
	const [c] = await tryQuery<{ Id: string; Name: string | null; ContractNumber: string | null; StartDate: string | null; EndDate: string | null; Store__r?: { Name: string } | null }>(
		`SELECT Id, Name, ContractNumber, StartDate, EndDate, Store__r.Name ${base}`,
		`SELECT Id, Name, ContractNumber, StartDate, EndDate ${base}`
	);
	if (!c) return null;

	const [lines, pays] = await Promise.all([
		tryQuery<{ Id: string; Quantity: number | null; UnitPrice: number | null; Description: string | null; Deposit__c?: number | null; PricebookEntry?: { Product2?: { Name: string } | null } | null }>(
			`SELECT Id, Quantity, UnitPrice, Description, Deposit__c, PricebookEntry.Product2.Name FROM ContractLineItem WHERE ServiceContractId = '${contractId}' ORDER BY CreatedDate ASC`,
			`SELECT Id, Quantity, UnitPrice, Description, PricebookEntry.Product2.Name FROM ContractLineItem WHERE ServiceContractId = '${contractId}' ORDER BY CreatedDate ASC`
		),
		sfdcQuery<{ Id: string; Name: string; Amount__c: number | null; Status__c: string | null; Payment_Type__c: string | null; Description__c: string | null; PaidAt__c: string | null; Payment_Date__c: string | null; CreatedDate: string }>(
			`SELECT Id, Name, Amount__c, Status__c, Payment_Type__c, Description__c, PaidAt__c, Payment_Date__c, CreatedDate FROM Payment__c WHERE Service_Contract__c = '${contractId}' AND Status__c != 'Cancelled' ORDER BY CreatedDate ASC`,
			{ paginate: true }
		).then((r) => r.records)
	]);

	const payments = pays.map((p) => ({
		id: p.Id, name: p.Name, description: p.Description__c, type: p.Payment_Type__c, amount: Number(p.Amount__c ?? 0),
		status: p.Status__c ?? 'Pending', payable: p.Status__c === STATUS_REQUEST,
		date: (p.PaidAt__c || p.Payment_Date__c || p.CreatedDate)?.slice(0, 10) ?? null
	}));
	const mapped = lines.map((l) => ({
		id: l.Id, name: l.PricebookEntry?.Product2?.Name ?? 'Service', description: l.Description,
		quantity: Number(l.Quantity ?? 1), unitPrice: Number(l.UnitPrice ?? 0),
		total: Number(l.Quantity ?? 1) * Number(l.UnitPrice ?? 0), deposit: l.Deposit__c != null ? Number(l.Deposit__c) : null
	}));
	const contractTotal = mapped.reduce((n, l) => n + l.total, 0);
	const paid = payments.filter((p) => p.status === 'Paid').reduce((n, p) => n + p.amount, 0);
	return {
		id: c.Id, name: c.Name ?? c.ContractNumber ?? 'Service contract', number: c.ContractNumber, startDate: c.StartDate, endDate: c.EndDate,
		storeName: c.Store__r?.Name ?? null, currency: (local?.currency ?? 'usd').toUpperCase(), lines: mapped, payments,
		totals: { contract: contractTotal, paid, due: payments.filter((p) => p.status !== 'Paid' && p.status !== 'Refunded').reduce((n, p) => n + p.amount, 0) }
	};
}
