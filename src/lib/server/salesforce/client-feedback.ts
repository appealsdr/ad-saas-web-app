/**
 * Salesforce Client_Feedback__c helpers.
 *
 * Field assumptions (rename in your org if different):
 *   - Client_Feedback__c.Client__c    — lookup to Account
 *   - Client_Feedback__c.Feedback__c  — rich text/long text area
 *   - Client_Feedback__c.Status__c    — picklist, defaults to 'New' on create
 */
import { sfdcQuery, sobjectCreate, sobjectUpdate, SalesforceApiError } from './client';
import { logError } from '../error_log';

const FEEDBACK_OBJECT = 'Client_Feedback__c';
const FEEDBACK_FIELDS = {
	client: 'Client__c',
	body: 'Feedback__c',
	status: 'Status__c'
};
const STATUS_NEW = 'New';

export interface ClientFeedback {
	Id: string;
	clientAccountId: string | null;
	body: string | null;
	status: string | null;
	createdAt: string;
	lastModifiedAt: string;
	createdByName: string | null;
}

interface ClientFeedbackRow {
	Id: string;
	Client__c: string | null;
	Feedback__c: string | null;
	Status__c: string | null;
	CreatedDate: string;
	LastModifiedDate: string;
	CreatedBy: { Name: string } | null;
}

function mapRow(r: ClientFeedbackRow): ClientFeedback {
	return {
		Id: r.Id,
		clientAccountId: r.Client__c,
		body: r.Feedback__c,
		status: r.Status__c,
		createdAt: r.CreatedDate,
		lastModifiedAt: r.LastModifiedDate,
		createdByName: r.CreatedBy?.Name ?? null
	};
}

export async function listClientFeedback(
	accountId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; feedback: ClientFeedback[] } | { ok: false; error: string }> {
	const escaped = accountId.replace(/'/g, "''");
	const soql = `
		SELECT Id, ${FEEDBACK_FIELDS.client}, ${FEEDBACK_FIELDS.body}, ${FEEDBACK_FIELDS.status},
		       CreatedDate, CreatedBy.Name, LastModifiedDate
		FROM ${FEEDBACK_OBJECT}
		WHERE ${FEEDBACK_FIELDS.client} = '${escaped}'
		ORDER BY CreatedDate DESC
		LIMIT 500
	`.trim();
	try {
		const result = await sfdcQuery<ClientFeedbackRow>(soql, { paginate: true });
		return { ok: true, feedback: result.records.map(mapRow) };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.client-feedback',
			operation: 'list',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: FEEDBACK_OBJECT,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { accountId }
		});
		return { ok: false, error: errorMessage };
	}
}

export async function fetchClientFeedback(
	feedbackId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; feedback: ClientFeedback } | { ok: false; error: string; notFound?: boolean }> {
	const escaped = feedbackId.replace(/'/g, "''");
	const soql = `
		SELECT Id, ${FEEDBACK_FIELDS.client}, ${FEEDBACK_FIELDS.body}, ${FEEDBACK_FIELDS.status},
		       CreatedDate, CreatedBy.Name, LastModifiedDate
		FROM ${FEEDBACK_OBJECT}
		WHERE Id = '${escaped}'
		LIMIT 1
	`.trim();
	try {
		const result = await sfdcQuery<ClientFeedbackRow>(soql);
		const row = result.records[0];
		if (!row) return { ok: false, error: 'Feedback not found.', notFound: true };
		return { ok: true, feedback: mapRow(row) };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.client-feedback',
			operation: 'fetch',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: FEEDBACK_OBJECT,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { feedbackId }
		});
		return { ok: false, error: errorMessage };
	}
}

export async function createClientFeedback(
	args: { accountId: string; body: string },
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; id: string } | { ok: false; error: string; errorCode?: string }> {
	const payload: Record<string, unknown> = {
		[FEEDBACK_FIELDS.client]: args.accountId,
		[FEEDBACK_FIELDS.body]: args.body,
		[FEEDBACK_FIELDS.status]: STATUS_NEW
	};
	try {
		const created = await sobjectCreate(FEEDBACK_OBJECT, payload);
		if (!created.success) {
			const error = `Salesforce ${FEEDBACK_OBJECT} create returned success=false: ${JSON.stringify(created.errors)}`;
			await logError({
				source: 'salesforce.client-feedback',
				operation: 'create',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: FEEDBACK_OBJECT,
				errorMessage: error,
				context: { payload }
			});
			return { ok: false, error };
		}
		return { ok: true, id: created.id };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.client-feedback',
			operation: 'create',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: FEEDBACK_OBJECT,
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { payload }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/** Client can only edit the feedback text itself, never the status. */
export async function updateClientFeedbackBody(
	feedbackId: string,
	body: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string; errorCode?: string }> {
	try {
		await sobjectUpdate(FEEDBACK_OBJECT, feedbackId, {
			[FEEDBACK_FIELDS.body]: body
		});
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.client-feedback',
			operation: 'update_body',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: FEEDBACK_OBJECT,
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { feedbackId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}
