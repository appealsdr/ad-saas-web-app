/**
 * "Waiting on Client" → "In Progress - Tech" once the client has done everything that was asked of them.
 *
 * Called after every client action on a case — a message, a file for a required-file slot, saved onboarding
 * information — whichever channel it came through (web app, upload link, API, MCP). The status changes only when:
 *   1. the case is "Waiting on Client";
 *   2. no message from our team is unanswered (the latest case message, if any, is the client's);
 *   3. every required file of the case is uploaded;
 *   4. onboarding information is provided, when the case asks for it;
 * and there was something to respond to (a message, a required file or onboarding). If any of that cannot be
 * read, the status is left alone.
 */
import { sfdcQuery, sobjectUpdate, SalesforceApiError } from './client';
import { logError } from '../error_log';
import { parseOnboardingConfig } from './case-onboarding';
import { isSalesforceId, soqlString } from './soql';

export const WAITING_ON_CLIENT = 'Waiting on Client';
export const IN_PROGRESS_TECH = 'In Progress - Tech';

type Context = { userId?: string; accountId?: string };

interface CaseRow {
	Status: string | null;
	Case_Onboarding__c?: string | null;
	Onboarding_Info_Provided__c?: boolean | null;
}

const isWaiting = (status: string | null) => status?.trim().toLowerCase() === WAITING_ON_CLIENT.toLowerCase();

async function readCase(id: string): Promise<CaseRow | undefined> {
	const read = (fields: string) => sfdcQuery<CaseRow>(`SELECT ${fields} FROM Case WHERE Id = ${id} LIMIT 1`);
	try {
		return (await read('Status, Case_Onboarding__c, Onboarding_Info_Provided__c')).records[0];
	} catch (e) {
		// An org without the onboarding fields asks for no onboarding. Any other failure stops here.
		if (!(e instanceof SalesforceApiError) || e.errorCode !== 'INVALID_FIELD') throw e;
		return (await read('Status')).records[0];
	}
}

/** Whether the case was moved. Never throws: the client's own action has already succeeded. */
export async function advanceCaseWhenClientDone(caseId: string, context: Context = {}): Promise<boolean> {
	if (!isSalesforceId(caseId)) return false;
	const id = soqlString(caseId);
	try {
		const row = await readCase(id);
		if (!row || !isWaiting(row.Status)) return false;

		const asksOnboarding = parseOnboardingConfig(row.Case_Onboarding__c).length > 0;
		if (asksOnboarding && !row.Onboarding_Info_Provided__c) return false;

		const files = await sfdcQuery<{ File_Uploaded__c: boolean | null; Last_Version__c: string | null }>(
			`SELECT File_Uploaded__c, Last_Version__c FROM Required_File__c WHERE Case__c = ${id} LIMIT 200`
		);
		if (files.records.some((f) => !f.File_Uploaded__c && !f.Last_Version__c)) return false;

		const [latest] = (
			await sfdcQuery<{ Sender_Type__c: string | null }>(
				`SELECT Sender_Type__c FROM Case_Message__c WHERE Case__c = ${id} ORDER BY CreatedDate DESC LIMIT 1`
			)
		).records;
		if (latest && latest.Sender_Type__c?.toLowerCase() !== 'external') return false;

		if (!latest && !files.records.length && !asksOnboarding) return false;

		await sobjectUpdate('Case', caseId, { Status: IN_PROGRESS_TECH });
		return true;
	} catch (e) {
		await logError({
			source: 'salesforce.case_auto_status',
			operation: 'advance',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Case',
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage: e instanceof Error ? e.message : String(e),
			context: { caseId }
		}).catch(() => {});
		return false;
	}
}
