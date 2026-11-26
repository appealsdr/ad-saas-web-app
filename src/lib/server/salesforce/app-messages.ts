/**
 * Salesforce App Messages (object Case_Message__c) — context-aware helpers.
 *
 * One message belongs to exactly ONE conversation context, selected by which
 * lookup is populated on the record:
 *   - Case     → Case_Message__c.Case__c
 *   - Account  → Case_Message__c.Account__c
 *   - Store__c → Case_Message__c.Store__c
 *
 * Other field assumptions (see also cases.ts):
 *   - Sender_Contact__c / Message_Body__c / Sender_Type__c ('external' for app users)
 *   - Reply_To_Message__c — self lookup (replies must stay in the same context)
 *   - Message_Read__c     — DateTime set when the recipient reads a message
 *
 * SECURITY: these helpers only validate *shape* (known context type, well-formed
 * Salesforce Id, same-context replies). Callers are responsible for resolving
 * `contextId` from a tenant-checked local record first — see
 * $lib/server/messages/conversation.ts. Never pass a browser-supplied
 * Salesforce Id straight through.
 *
 * Errors returned to callers are deliberately generic; diagnostic detail goes
 * to the error log only.
 */
import { sfdcQuery, sobjectCreate, sobjectUpdate, SalesforceApiError } from './client';
import { logError } from '../error_log';
import {
	APP_MESSAGE_CONTEXT_TYPES,
	type AppMessage,
	type AppMessageContext,
	type AppMessageContextType,
	type AppMessageWithContext
} from '$lib/types/app-message';
import { isSalesforceId, soqlList, soqlString } from './soql';

export const APP_MESSAGE_OBJECT = 'Case_Message__c';

const CONTEXT_LOOKUP_FIELD: Record<AppMessageContextType, string> = {
	Case: 'Case__c',
	Account: 'Account__c',
	Store__c: 'Store__c'
};

const FIELDS = {
	senderContact: 'Sender_Contact__c',
	body: 'Message_Body__c',
	senderType: 'Sender_Type__c',
	replyTo: 'Reply_To_Message__c',
	read: 'Message_Read__c'
};
const SENDER_TYPE_EXTERNAL = 'external';

/** Hard cap per conversation fetch (matches the previous Case-only behaviour). */
const LIST_LIMIT = 500;
/** Cap for cross-record rollups (topbar notifications). */
const ROLLUP_LIMIT_MAX = 200;

export interface AppMessageRequestContext {
	userId?: string;
	accountId?: string;
}

export type AppMessageResult<T> = ({ ok: true } & T) | { ok: false; error: string; errorCode?: string };

// ─── Validation helpers (pure — exported for tests) ─────────────────────

export { isSalesforceId as isValidSalesforceId };

export function isAppMessageContextType(value: unknown): value is AppMessageContextType {
	return typeof value === 'string' && (APP_MESSAGE_CONTEXT_TYPES as readonly string[]).includes(value);
}

/** Context → the Case_Message__c lookup that scopes it. Throws on unsupported input. */
export function contextLookupField(contextType: AppMessageContextType): string {
	if (!isAppMessageContextType(contextType)) {
		throw new Error(`Unsupported message context type: ${String(contextType)}`);
	}
	return CONTEXT_LOOKUP_FIELD[contextType];
}

/** Validate an untrusted context; returns a clear, client-safe error on failure. */
export function validateAppMessageContext(
	context: Partial<AppMessageContext> | null | undefined
): { ok: true; value: AppMessageContext } | { ok: false; error: string } {
	if (!context || typeof context !== 'object') return { ok: false, error: 'Missing message context.' };
	const { contextType, contextId } = context;
	if (!contextType) return { ok: false, error: 'Missing message context type.' };
	if (!isAppMessageContextType(contextType)) {
		return { ok: false, error: 'Unsupported message context type.' };
	}
	if (!contextId) return { ok: false, error: 'Missing message context record.' };
	if (!isSalesforceId(contextId)) return { ok: false, error: 'Invalid message context record.' };
	return { ok: true, value: { contextType, contextId } };
}

// ─── Row mapping ────────────────────────────────────────────────────────

interface AppMessageRow {
	Id: string;
	Message_Body__c: string | null;
	Sender_Type__c: string | null;
	Sender_Contact__c: string | null;
	Sender_Contact__r: { Name: string } | null;
	CreatedById: string | null;
	CreatedBy: { Name: string } | null;
	CreatedDate: string;
	Reply_To_Message__c: string | null;
	Message_Read__c: string | null;
}

const BASE_SELECT = `Id, ${FIELDS.body}, ${FIELDS.senderType},
	       ${FIELDS.senderContact}, Sender_Contact__r.Name,
	       CreatedById, CreatedBy.Name,
	       CreatedDate, ${FIELDS.replyTo}, ${FIELDS.read}`;

export function mapAppMessageRow(r: AppMessageRow): AppMessage {
	return {
		Id: r.Id,
		body: r.Message_Body__c,
		senderType: r.Sender_Type__c,
		senderContactId: r.Sender_Contact__c,
		senderContactName: r.Sender_Contact__r?.Name ?? null,
		createdById: r.CreatedById,
		createdByName: r.CreatedBy?.Name ?? null,
		displayName: r.Sender_Contact__r?.Name ?? r.CreatedBy?.Name ?? null,
		createdAt: r.CreatedDate,
		replyToMessageId: r.Reply_To_Message__c,
		messageRead: r.Message_Read__c
	};
}

async function logSfError(
	operation: string,
	e: unknown,
	reqCtx: AppMessageRequestContext,
	extra: Record<string, unknown>
): Promise<{ errorCode?: string }> {
	const isSfErr = e instanceof SalesforceApiError;
	const errorCode = isSfErr ? e.errorCode : undefined;
	await logError({
		source: 'salesforce.app_messages',
		operation,
		userId: reqCtx.userId,
		accountId: reqCtx.accountId,
		sfdcObject: APP_MESSAGE_OBJECT,
		errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
		errorMessage: e instanceof Error ? e.message : String(e),
		stack: e instanceof Error ? e.stack : undefined,
		context: extra
	});
	return { errorCode };
}

// ─── List ───────────────────────────────────────────────────────────────

/** Messages directly assigned to one context, oldest first. */
export async function listAppMessages(
	context: Partial<AppMessageContext>,
	reqCtx: AppMessageRequestContext = {}
): Promise<AppMessageResult<{ messages: AppMessage[] }>> {
	const v = validateAppMessageContext(context);
	if (!v.ok) return { ok: false, error: v.error };
	const { contextType, contextId } = v.value;
	const soql = `
		SELECT ${BASE_SELECT}
		FROM ${APP_MESSAGE_OBJECT}
		WHERE ${contextLookupField(contextType)} = ${soqlString(contextId)}
		ORDER BY CreatedDate ASC
		LIMIT ${LIST_LIMIT}
	`.trim();
	try {
		const result = await sfdcQuery<AppMessageRow>(soql, { paginate: true });
		return { ok: true, messages: result.records.map(mapAppMessageRow) };
	} catch (e) {
		await logSfError('list_messages', e, reqCtx, { contextType, contextId });
		return { ok: false, error: 'Could not load messages. Please try again.' };
	}
}

/**
 * Recent messages across MANY records of ONE context type, newest first — used by
 * the topbar notifications (`unreadOnly`) and the dashboard activity feed.
 * Empty input → empty result, no round-trip.
 */
export async function listRecentAppMessagesForContexts(
	contextType: AppMessageContextType,
	contextIds: string[],
	limit: number,
	reqCtx: AppMessageRequestContext = {},
	options: { unreadOnly?: boolean } = {}
): Promise<AppMessageResult<{ messages: AppMessageWithContext[] }>> {
	if (!isAppMessageContextType(contextType)) {
		return { ok: false, error: 'Unsupported message context type.' };
	}
	const ids = [...new Set(contextIds)];
	if (ids.length === 0) return { ok: true, messages: [] };
	if (!ids.every(isSalesforceId)) return { ok: false, error: 'Invalid message context record.' };
	const cleanLimit = Math.max(1, Math.min(ROLLUP_LIMIT_MAX, limit | 0));
	const field = contextLookupField(contextType);
	const literals = soqlList(ids);
	const caseNumber = contextType === 'Case' ? ', Case__r.CaseNumber' : '';
	const soql = `
		SELECT ${BASE_SELECT}, ${field}${caseNumber}
		FROM ${APP_MESSAGE_OBJECT}
		WHERE ${field} IN (${literals})${options.unreadOnly ? ` AND ${FIELDS.read} = null` : ''}
		ORDER BY CreatedDate DESC
		LIMIT ${cleanLimit}
	`.trim();
	try {
		const result = await sfdcQuery<
			AppMessageRow & Record<string, unknown> & { Case__r?: { CaseNumber: string } | null }
		>(soql);
		const messages = result.records.map(
			(r): AppMessageWithContext => ({
				...mapAppMessageRow(r),
				contextType,
				contextId: String(r[field] ?? ''),
				caseNumber: contextType === 'Case' ? (r.Case__r?.CaseNumber ?? '') : null
			})
		);
		return { ok: true, messages };
	} catch (e) {
		await logSfError('list_recent_for_contexts', e, reqCtx, { contextType, count: ids.length });
		return { ok: false, error: 'Could not load messages.' };
	}
}

// ─── Create ─────────────────────────────────────────────────────────────

/**
 * Confirm `messageId` is a message of exactly this context. Used for reply
 * validation and before PATCHing read receipts.
 */
export async function messageBelongsToContext(
	messageId: string,
	context: AppMessageContext,
	reqCtx: AppMessageRequestContext = {}
): Promise<AppMessageResult<{ belongs: boolean }>> {
	const v = validateAppMessageContext(context);
	if (!v.ok) return { ok: false, error: v.error };
	if (!isSalesforceId(messageId)) return { ok: false, error: 'Invalid message id.' };
	const soql = `SELECT Id FROM ${APP_MESSAGE_OBJECT} WHERE Id = ${soqlString(messageId)} AND ${contextLookupField(
		v.value.contextType
	)} = ${soqlString(v.value.contextId)} LIMIT 1`;
	try {
		const result = await sfdcQuery<{ Id: string }>(soql);
		return { ok: true, belongs: result.records.length > 0 };
	} catch (e) {
		await logSfError('verify_message_context', e, reqCtx, { messageId, ...v.value });
		return { ok: false, error: 'Could not verify the message. Please try again.' };
	}
}

export interface CreateAppMessageArgs extends Partial<AppMessageContext> {
	senderContactId: string;
	body: string;
	replyToMessageId?: string | null;
}

/** Create a message with exactly ONE context lookup populated. */
export async function createAppMessage(
	args: CreateAppMessageArgs,
	reqCtx: AppMessageRequestContext = {}
): Promise<AppMessageResult<{ id: string }>> {
	const v = validateAppMessageContext(args);
	if (!v.ok) return { ok: false, error: v.error };
	const { contextType, contextId } = v.value;
	if (!args.senderContactId) return { ok: false, error: 'Missing sender.' };
	if (!isSalesforceId(args.senderContactId)) return { ok: false, error: 'Invalid sender.' };
	if (typeof args.body !== 'string' || !args.body.trim()) {
		return { ok: false, error: 'Message cannot be empty.' };
	}

	const replyTo = args.replyToMessageId || null;
	if (replyTo) {
		if (!isSalesforceId(replyTo)) return { ok: false, error: 'Invalid reply target.' };
		const check = await messageBelongsToContext(replyTo, v.value, reqCtx);
		if (!check.ok) return { ok: false, error: check.error };
		if (!check.belongs) {
			return { ok: false, error: 'You can only reply to a message in the same conversation.' };
		}
	}

	const payload: Record<string, unknown> = {
		[contextLookupField(contextType)]: contextId, // the ONLY context lookup we set
		[FIELDS.senderContact]: args.senderContactId,
		[FIELDS.body]: args.body,
		[FIELDS.senderType]: SENDER_TYPE_EXTERNAL
	};
	if (replyTo) payload[FIELDS.replyTo] = replyTo;

	try {
		const created = await sobjectCreate(APP_MESSAGE_OBJECT, payload);
		if (!created.success) {
			await logError({
				source: 'salesforce.app_messages',
				operation: 'create_message',
				userId: reqCtx.userId,
				accountId: reqCtx.accountId,
				sfdcObject: APP_MESSAGE_OBJECT,
				errorMessage: `create returned success=false: ${JSON.stringify(created.errors)}`,
				context: { contextType, contextId }
			});
			return { ok: false, error: 'Salesforce could not save the message. Please try again.' };
		}
		// Messages created here are the client's: this may be the reply the case was waiting for.
		return { ok: true, id: created.id };
	} catch (e) {
		const { errorCode } = await logSfError('create_message', e, reqCtx, { contextType, contextId });
		return { ok: false, error: 'Salesforce could not save the message. Please try again.', errorCode };
	}
}

// ─── Read receipts ──────────────────────────────────────────────────────

/**
 * PATCH Message_Read__c to now. Idempotent. When `scope` is given the message is
 * first verified to belong to that (tenant-checked) context, so a forged message
 * id from another tenant can never be marked read.
 */
export async function markAppMessageRead(
	messageId: string,
	reqCtx: AppMessageRequestContext = {},
	scope?: AppMessageContext
): Promise<AppMessageResult<unknown>> {
	if (!messageId) return { ok: false, error: 'Missing message id.' };
	if (!isSalesforceId(messageId)) return { ok: false, error: 'Invalid message id.' };
	if (scope) {
		const check = await messageBelongsToContext(messageId, scope, reqCtx);
		if (!check.ok) return { ok: false, error: check.error };
		if (!check.belongs) return { ok: false, error: 'Message not found in this conversation.' };
	}
	try {
		await sobjectUpdate(APP_MESSAGE_OBJECT, messageId, { [FIELDS.read]: new Date().toISOString() });
		return { ok: true };
	} catch (e) {
		const { errorCode } = await logSfError('mark_message_read', e, reqCtx, { messageId });
		return { ok: false, error: 'Could not mark the message as read.', errorCode };
	}
}
