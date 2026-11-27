/**
 * "Waiting on Client" → "In Progress - Tech".
 *
 * In the web app the client decides: once they have done everything asked of them they are offered
 * "Notify technician" (also shown beside the status while the case waits, enabled once nothing is outstanding),
 * and only that changes the status.
 * Channels that cannot show that choice — upload link, API, MCP — change it automatically after the client's
 * message or file.
 *
 * "Everything asked" means all of (2–4 are also what enables the button):
 *   1. the case is "Waiting on Client";
 *   2. no message from our team is unanswered (the latest case message, if any, is the client's);
 *   3. every required file of the case is uploaded;
 *   4. onboarding information is provided, when the case asks for it;
 * and there was something to respond to (a message, a required file or onboarding). If any of that cannot be
 * read, the answer is "not done".
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

async function logFailure(operation: string, caseId: string, context: Context, e: unknown) {
	await logError({
		source: 'salesforce.case_auto_status',
		operation,
		userId: context.userId,
		accountId: context.accountId,
		sfdcObject: 'Case',
		errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
		errorMessage: e instanceof Error ? e.message : String(e),
		context: { caseId }
	}).catch(() => {});
}

/** What the client still owes on a waiting case, in their words. */
async function readProgress(caseId: string) {
	const id = soqlString(caseId);
	const row = await readCase(id);
	const status = row?.Status ?? null;
	if (!row || !isWaiting(status)) return { status, waiting: false as const };

	const asksOnboarding = parseOnboardingConfig(row.Case_Onboarding__c).length > 0;
	const files = await sfdcQuery<{ File_Uploaded__c: boolean | null; Last_Version__c: string | null }>(
		`SELECT File_Uploaded__c, Last_Version__c FROM Required_File__c WHERE Case__c = ${id} LIMIT 200`
	);
	const missing = files.records.filter((f) => !f.File_Uploaded__c && !f.Last_Version__c).length;
	const [latest] = (
		await sfdcQuery<{ Sender_Type__c: string | null }>(
			`SELECT Sender_Type__c FROM Case_Message__c WHERE Case__c = ${id} ORDER BY CreatedDate DESC LIMIT 1`
		)
	).records;

	const todo: string[] = [];
	if (latest && latest.Sender_Type__c?.toLowerCase() !== 'external') todo.push("Reply to our team's latest message");
	if (missing) todo.push(missing === 1 ? 'Upload 1 requested document' : `Upload ${missing} requested documents`);
	if (asksOnboarding && !row.Onboarding_Info_Provided__c) todo.push('Provide the onboarding information');

	/** Whether there was ever something to respond to. */
	const asked = !!latest || files.records.length > 0 || asksOnboarding;
	return { status, waiting: true as const, todo, asked };
}

async function everythingAskedIsDone(caseId: string): Promise<boolean> {
	const progress = await readProgress(caseId);
	return progress.waiting && progress.asked && progress.todo.length === 0;
}

/**
 * What still blocks "Notify technician": empty when nothing does (or the case is not waiting), null when it
 * cannot be checked. Never throws.
 */
export async function getClientTodo(caseId: string, context: Context = {}): Promise<string[] | null> {
	if (!isSalesforceId(caseId)) return null;
	try {
		const progress = await readProgress(caseId);
		return progress.waiting ? progress.todo : [];
	} catch (e) {
		await logFailure('todo', caseId, context, e);
		return null;
	}
}

/** Whether to offer "Notify technician" after a client action. Never throws. */
export async function isCaseReadyForTechnician(caseId: string, context: Context = {}): Promise<boolean> {
	if (!isSalesforceId(caseId)) return false;
	try {
		return await everythingAskedIsDone(caseId);
	} catch (e) {
		await logFailure('check', caseId, context, e);
		return false;
	}
}

/** Whether the case was moved. Never throws: the client's own action has already succeeded. */
export async function advanceCaseWhenClientDone(caseId: string, context: Context = {}): Promise<boolean> {
	if (!isSalesforceId(caseId)) return false;
	try {
		if (!(await everythingAskedIsDone(caseId))) return false;
		await sobjectUpdate('Case', caseId, { Status: IN_PROGRESS_TECH });
		return true;
	} catch (e) {
		await logFailure('advance', caseId, context, e);
		return false;
	}
}

export type NotifyResult = { ok: true } | { ok: false; status: number; error: string };

/**
 * The client's "Notify technician". Allowed only on a case waiting on them with nothing left outstanding.
 * The caller must already have checked that the case is the client's own.
 */
export async function notifyTechnician(caseId: string, context: Context = {}): Promise<NotifyResult> {
	if (!isSalesforceId(caseId)) return { ok: false, status: 404, error: 'Case not found.' };
	try {
		const progress = await readProgress(caseId);
		// A second click, or a colleague got there first.
		if (progress.status === IN_PROGRESS_TECH) return { ok: true };
		if (!progress.waiting) return { ok: false, status: 409, error: 'This case is no longer waiting on you.' };
		if (progress.todo.length) {
			return { ok: false, status: 409, error: `Please finish these first: ${progress.todo.join('; ')}.` };
		}
		await sobjectUpdate('Case', caseId, { Status: IN_PROGRESS_TECH });
		return { ok: true };
	} catch (e) {
		await logFailure('notify', caseId, context, e);
		return { ok: false, status: 502, error: 'Could not notify the technician. Please try again.' };
	}
}
