/**
 * Cases auto-created from a paid ServiceContract.
 *
 * When a ServiceContract + ContractLineItems are created in Salesforce, we
 * open one Case per line item so the technician team can start work. Also
 * exposes listing cases for a contract (Contract__c filter) for the contract
 * detail screen.
 */
import { sfdcQuery, sobjectCreate, SalesforceApiError } from './client';
import { logError } from '../error_log';
import type { CaseSummary } from './cases';

const CASE_OBJECT = 'Case';

// Resolve the "Custom" Case record type id once per process.
let cachedCustomRecordTypeId: string | null | undefined;

export async function getCaseCustomRecordTypeId(): Promise<string | null> {
	if (cachedCustomRecordTypeId !== undefined) return cachedCustomRecordTypeId;
	try {
		const r = await sfdcQuery<{ Id: string }>(
			`SELECT Id FROM RecordType WHERE SObjectType = 'Case' AND (DeveloperName = 'Custom' OR Name = 'Custom') LIMIT 1`
		);
		cachedCustomRecordTypeId = r.records[0]?.Id ?? null;
	} catch {
		cachedCustomRecordTypeId = null; // field/object not accessible → create without record type
	}
	return cachedCustomRecordTypeId;
}

export interface ServiceCaseInput {
	sfdcContractId: string;
	sfdcContractLineItemId: string;
	subject: string; // the service name
	sfdcAccountId: string;
	sfdcStoreId: string | null;
	sfdcContactId: string | null; // store point of contact
}

export type ServiceCaseResult =
	| { ok: true; id: string }
	| { ok: false; error: string; errorCode?: string };

/** Create one Case for a service line item. Best-effort (logs on failure). */
export async function createServiceCase(
	input: ServiceCaseInput,
	context: { userId?: string; accountId?: string } = {}
): Promise<ServiceCaseResult> {
	const recordTypeId = await getCaseCustomRecordTypeId();

	const payload: Record<string, unknown> = {
		Contract__c: input.sfdcContractId,
		Contract_Line_Item__c: input.sfdcContractLineItemId,
		Subject: input.subject,
		AccountId: input.sfdcAccountId,
		Status: 'New',
		Priority: 'High'
	};
	if (recordTypeId) payload.RecordTypeId = recordTypeId;
	if (input.sfdcStoreId) payload.Store__c = input.sfdcStoreId;
	if (input.sfdcContactId) payload.ContactId = input.sfdcContactId;

	try {
		const created = await sobjectCreate(CASE_OBJECT, payload);
		if (!created.success) {
			const error = `Case create returned success=false: ${JSON.stringify(created.errors)}`;
			await logError({
				source: 'salesforce.service_cases',
				operation: 'create_case',
				severity: 'warn',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: CASE_OBJECT,
				errorMessage: error,
				context: { contractId: input.sfdcContractId, lineItemId: input.sfdcContractLineItemId }
			});
			return { ok: false, error };
		}
		return { ok: true, id: created.id };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.service_cases',
			operation: 'create_case',
			severity: 'warn',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: CASE_OBJECT,
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { contractId: input.sfdcContractId, lineItemId: input.sfdcContractLineItemId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/** List the Cases attached to a ServiceContract (Contract__c filter). */
export async function listCasesForContract(
	sfdcContractId: string
): Promise<{ ok: true; cases: CaseSummary[] } | { ok: false; error: string }> {
	const escaped = sfdcContractId.replace(/'/g, "''");
	const soql = `
		SELECT Id, CaseNumber, Subject, Status, Priority, CreatedDate, LastModifiedDate, RecordType.Name
		FROM ${CASE_OBJECT}
		WHERE Contract__c = '${escaped}'
		ORDER BY CreatedDate DESC
		LIMIT 200
	`.trim();
	try {
		const result = await sfdcQuery<{
			Id: string;
			CaseNumber: string;
			Subject: string | null;
			Status: string;
			Priority: string | null;
			CreatedDate: string;
			LastModifiedDate: string;
			RecordType: { Name: string } | null;
		}>(soql);
		return {
			ok: true,
			cases: result.records.map((r) => ({
				Id: r.Id,
				CaseNumber: r.CaseNumber,
				Subject: r.Subject,
				Status: r.Status,
				Priority: r.Priority,
				CreatedDate: r.CreatedDate,
				LastModifiedDate: r.LastModifiedDate,
				recordTypeName: r.RecordType?.Name ?? null
			}))
		};
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.service_cases',
			operation: 'list_for_contract',
			sfdcObject: CASE_OBJECT,
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage,
			context: { contractId: sfdcContractId }
		});
		return { ok: false, error: errorMessage };
	}
}
