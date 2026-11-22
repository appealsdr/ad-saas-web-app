/**
 * Tenant-scoped App Message conversations (Account / Store / Case).
 *
 * Every page that shows a conversation goes through here so the tenant checks
 * live in ONE place:
 *
 *   1. resolve*Scope()  — derive the Salesforce context id from a LOCAL record the
 *      signed-in user owns (Account: users→accounts.sfdc_account_id; Store:
 *      stores row in the user's account → sfdc_store_id; Case: store scope + the
 *      Case's Store__c must equal that store's sfdc_store_id). The browser never
 *      supplies a Salesforce id for the conversation.
 *   2. loadConversation() / postConversationMessage() / markConversationRead() —
 *      operate only on the resolved scope.
 *
 * Messages are sanitized here, before they reach the browser ({@html} rendering),
 * and Salesforce/database error details are logged, never returned to the client.
 */
import { sql } from '$lib/server/db';
import { logError } from '$lib/server/error_log';
import { sanitizeMessageHtml, validateMessageBody } from '$lib/server/sanitize';
import {
	listAppMessages,
	createAppMessage,
	markAppMessageRead,
	findCaseStoreLookup
} from '$lib/server/salesforce';
import {
	conversationKindFor,
	type AppMessageContextType,
	type ConversationData,
	type ConversationScopeKind
} from '$lib/types/app-message';

export interface ConversationScope {
	kind: ConversationScopeKind;
	contextType: AppMessageContextType;
	/** Server-resolved Salesforce record id; null when the local record isn't linked. */
	contextId: string | null;
	/** Local account that owns the context (tenant). */
	accountId: string;
	/** Why the conversation can't be used (not linked to Salesforce, ...). */
	unavailableReason: string | null;
	/** Display metadata for the scope header. */
	label: string;
}

export interface SessionUser {
	id: string;
}

export type { ConversationData };

const NOT_LINKED_CONTACT =
	'Your Salesforce Contact is not linked yet, so you can read messages but not send them. Try again once sync completes.';

// ─── Scope resolution (tenant checks) ───────────────────────────────────

/** Account conversation for the signed-in user's own account. */
export async function resolveAccountScope(user: SessionUser): Promise<ConversationScope | null> {
	const [row] = await sql<{ account_id: string; name: string; sfdc_account_id: string | null }[]>`
		SELECT a.id AS account_id, a.name, COALESCE(a.sfdc_account_id, u.sfdc_account_id) AS sfdc_account_id
		FROM users u JOIN accounts a ON a.id = u.account_id
		WHERE u.id = ${user.id}
		LIMIT 1
	`;
	if (!row) return null;
	return {
		kind: 'account',
		contextType: 'Account',
		contextId: row.sfdc_account_id,
		accountId: row.account_id,
		unavailableReason: row.sfdc_account_id
			? null
			: 'This account is not linked to Salesforce yet, so account messages are unavailable.',
		label: row.name
	};
}

interface StoreScopeRow {
	id: string;
	account_id: string;
	name: string;
	sfdc_store_id: string | null;
}

async function loadOwnedStore(user: SessionUser, storeId: string): Promise<StoreScopeRow | null> {
	const [row] = await sql<StoreScopeRow[]>`
		SELECT s.id, s.account_id, s.name, s.sfdc_store_id
		FROM stores s JOIN users u ON u.id = ${user.id}
		WHERE s.id = ${storeId} AND s.account_id = u.account_id
		LIMIT 1
	`;
	return row ?? null;
}

/** Store conversation; the store must belong to the signed-in user's account. */
export async function resolveStoreScope(
	user: SessionUser,
	storeId: string
): Promise<ConversationScope | null> {
	const store = await loadOwnedStore(user, storeId);
	if (!store) return null;
	return {
		kind: 'store',
		contextType: 'Store__c',
		contextId: store.sfdc_store_id,
		accountId: store.account_id,
		unavailableReason: store.sfdc_store_id
			? null
			: 'This store is not linked to Salesforce yet, so store messages are unavailable.',
		label: store.name
	};
}

/**
 * Case conversation. Tenant check: the store belongs to the user's account AND
 * the Case's Store__c equals that store's sfdc_store_id. Returns:
 *   - null                      → not found / not this tenant's case (render 404)
 *   - { scope.contextId: null } → couldn't verify right now (transient SF error)
 */
export async function resolveCaseScope(
	user: SessionUser,
	storeId: string,
	caseId: string
): Promise<ConversationScope | null> {
	const store = await loadOwnedStore(user, storeId);
	if (!store) return null;
	const base = {
		kind: 'case' as const,
		contextType: 'Case' as const,
		accountId: store.account_id,
		label: store.name
	};
	if (!store.sfdc_store_id) {
		return {
			...base,
			contextId: null,
			unavailableReason: 'This store is not linked to Salesforce yet, so case messages are unavailable.'
		};
	}
	const lookup = await findCaseStoreLookup(caseId, { userId: user.id, accountId: store.account_id });
	if (!lookup.ok) {
		if (lookup.notFound) return null;
		return {
			...base,
			contextId: null,
			unavailableReason: 'Messages are temporarily unavailable. Please try again.'
		};
	}
	if (lookup.sfdcStoreId !== store.sfdc_store_id) return null; // someone else's case
	return { ...base, contextId: lookup.sfdcCaseId, unavailableReason: null };
}

// ─── Operations on a resolved scope ─────────────────────────────────────

async function getContactId(user: SessionUser): Promise<string | null> {
	const [row] = await sql<{ sfdc_contact_id: string | null }[]>`
		SELECT sfdc_contact_id FROM users WHERE id = ${user.id} LIMIT 1
	`;
	return row?.sfdc_contact_id ?? null;
}

export async function loadConversation(
	scope: ConversationScope,
	user: SessionUser
): Promise<ConversationData> {
	const contactId = await getContactId(user);
	const base: ConversationData = {
		kind: scope.kind,
		contextType: scope.contextType,
		contextId: scope.contextId,
		available: !!scope.contextId,
		unavailableReason: scope.unavailableReason,
		canSend: !!scope.contextId && !!contactId,
		sendDisabledReason: contactId ? null : NOT_LINKED_CONTACT,
		messages: [],
		error: null,
		currentContactId: contactId
	};
	if (!scope.contextId) return base;

	const res = await listAppMessages(
		{ contextType: scope.contextType, contextId: scope.contextId },
		{ userId: user.id, accountId: scope.accountId }
	);
	if (!res.ok) return { ...base, error: res.error };
	return {
		...base,
		// Bodies come back from Salesforce and are rendered with {@html}: sanitize first.
		messages: res.messages.map((m) => ({ ...m, body: sanitizeMessageHtml(m.body) }))
	};
}

export type PostResult =
	| { ok: true }
	| { ok: false; status: number; error: string; body: string };

/** Validate → check contact + context → create. `body` echoes input for form repopulation. */
export async function postConversationMessage(
	scope: ConversationScope,
	user: SessionUser,
	form: FormData
): Promise<PostResult> {
	const rawBody = String(form.get('body') ?? '');
	const replyToMessageId = String(form.get('replyToMessageId') ?? '').trim() || null;

	const checked = validateMessageBody(rawBody);
	if (!checked.ok) return { ok: false, status: 400, error: checked.error, body: rawBody };

	if (!scope.contextId) {
		return {
			ok: false,
			status: 409,
			error: scope.unavailableReason ?? 'This conversation is unavailable.',
			body: checked.body
		};
	}
	const contactId = await getContactId(user);
	if (!contactId) return { ok: false, status: 409, error: NOT_LINKED_CONTACT, body: checked.body };

	const created = await createAppMessage(
		{
			contextType: scope.contextType,
			contextId: scope.contextId,
			senderContactId: contactId,
			body: checked.body,
			replyToMessageId
		},
		{ userId: user.id, accountId: scope.accountId }
	);
	if (!created.ok) {
		const isReplyError = /same conversation|reply target/i.test(created.error);
		return {
			ok: false,
			status: isReplyError ? 400 : 502,
			error: created.error,
			body: checked.body
		};
	}
	return { ok: true };
}

export async function markConversationRead(
	scope: ConversationScope,
	user: SessionUser,
	messageId: string
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
	if (!messageId) return { ok: false, status: 400, error: 'Missing message id.' };
	if (!scope.contextId) return { ok: false, status: 409, error: 'This conversation is unavailable.' };
	const res = await markAppMessageRead(
		messageId,
		{ userId: user.id, accountId: scope.accountId },
		{ contextType: scope.contextType, contextId: scope.contextId }
	);
	if (!res.ok) return { ok: false, status: 502, error: res.error };
	return { ok: true };
}

/** For callers that only have a context type and want the scope kind. */
export { conversationKindFor };

/** Log + swallow — a failed conversation load must never break the host page. */
export async function loadConversationSafe(
	scope: ConversationScope,
	user: SessionUser
): Promise<ConversationData> {
	try {
		return await loadConversation(scope, user);
	} catch (e) {
		await logError({
			source: 'messages.conversation',
			operation: 'load',
			userId: user.id,
			accountId: scope.accountId,
			errorMessage: e instanceof Error ? e.message : String(e),
			stack: e instanceof Error ? e.stack : undefined,
			context: { contextType: scope.contextType }
		});
		return {
			kind: scope.kind,
			contextType: scope.contextType,
			contextId: scope.contextId,
			available: !!scope.contextId,
			unavailableReason: scope.unavailableReason,
			canSend: false,
			sendDisabledReason: null,
			messages: [],
			error: 'Could not load messages. Please try again.',
			currentContactId: null
		};
	}
}
