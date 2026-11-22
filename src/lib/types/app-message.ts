/**
 * Context-neutral "App Message" types (Salesforce object Case_Message__c).
 *
 * A message belongs to exactly ONE conversation context:
 *   - Case     → Case_Message__c.Case__c
 *   - Account  → Case_Message__c.Account__c
 *   - Store__c → Case_Message__c.Store__c
 */
export const APP_MESSAGE_CONTEXT_TYPES = ['Case', 'Account', 'Store__c'] as const;
export type AppMessageContextType = (typeof APP_MESSAGE_CONTEXT_TYPES)[number];

export interface AppMessageContext {
	contextType: AppMessageContextType;
	/** Salesforce record Id of the Case / Account / Store__c. */
	contextId: string;
}

export interface AppMessage {
	Id: string;
	body: string | null;
	senderType: string | null;
	senderContactId: string | null;
	/** From Sender_Contact__r.Name — the linked Contact, if any. */
	senderContactName: string | null;
	/** From CreatedBy.Name — the Salesforce User who saved the record. */
	createdByName: string | null;
	createdById: string | null;
	/** Best display name: linked Contact first, else the Salesforce User. */
	displayName: string | null;
	createdAt: string;
	/** Reply_To_Message__c — Id of the message this one replies to, if any. */
	replyToMessageId: string | null;
	/** Message_Read__c — when the recipient read this message, or null if unread. */
	messageRead: string | null;
}

/** An AppMessage plus the context record it was loaded for (rollups across records). */
export interface AppMessageWithContext extends AppMessage {
	contextType: AppMessageContextType;
	contextId: string;
	/** Case.CaseNumber when contextType is 'Case'. */
	caseNumber: string | null;
}

/** Where a conversation is rendered; drives scope header copy in the shared UI. */
export type ConversationScopeKind = 'account' | 'store' | 'case';

export function conversationKindFor(type: AppMessageContextType): ConversationScopeKind {
	return type === 'Account' ? 'account' : type === 'Store__c' ? 'store' : 'case';
}

/** What a page hands to <ConversationPanel> (plus form-action wiring). */
export interface ConversationData {
	kind: ConversationScopeKind;
	contextType: AppMessageContextType;
	contextId: string | null;
	available: boolean;
	unavailableReason: string | null;
	/** False when the user has no linked Salesforce Contact (can read, can't send). */
	canSend: boolean;
	sendDisabledReason: string | null;
	messages: AppMessage[];
	error: string | null;
	currentContactId: string | null;
}
