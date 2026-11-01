/**
 * Salesforce Case + Case_Message__c helpers.
 *
 * Cases are read-only from this app — sellers can browse them and post
 * comments, but the Case itself is created elsewhere (Salesforce, SP-API,
 * Slack flow, etc.).
 *
 * Field assumptions (rename in your org if different):
 *   - Case.Store__c                    — lookup to Store__c
 *   - Case_Message__c.Case__c          — lookup to Case
 *   - Case_Message__c.Sender_Contact__c
 *   - Case_Message__c.Message_Body__c
 *   - Case_Message__c.Sender_Type__c   — 'external' for app users
 *   - Case_Message__c.Reply_To_Message__c — lookup to Case_Message__c (self);
 *                                           NOT YET CREATED in the org as of this
 *                                           change — add it before deploying.
 *   - Case_Message__c.Message_Read__c  — DateTime, set when a message is read;
 *                                        NOT YET CREATED in the org as of this
 *                                        change — add it before deploying.
 */
import { sfdcQuery, sobjectGet, sobjectCreate, sobjectUpdate, SalesforceApiError } from './client';
import { logError } from '../error_log';
import type { CaseTimelineEvent, CaseTimelineEventType } from '$lib/types/case-timeline';
export type { CaseTimelineEvent, CaseTimelineEventType } from '$lib/types/case-timeline';

const CASE_STORE_FIELD = 'Store__c'; // Case → Store__c lookup
const CM_CASE_FIELD = 'Case__c';     // Case_Message__c → Case lookup
const CM_FIELDS = {
	senderContact: 'Sender_Contact__c',
	body: 'Message_Body__c',
	senderType: 'Sender_Type__c',
	replyTo: 'Reply_To_Message__c',
	read: 'Message_Read__c'
};
const SENDER_TYPE_EXTERNAL = 'external';

// ── Case_File__c (required-file checklist) ──
const CASE_FILE_OBJECT = 'Case_File__c';
const CASE_FILE_FIELDS = {
	case: 'Case__c',
	store: 'Store__c',
	shortDescription: 'Short_Description__c',
	clientFileInfo: 'Client_File_Info__c'
};

// ─── Types ──────────────────────────────────────────────────────────────

export interface CaseSummary {
	Id: string;
	CaseNumber: string;
	Subject: string | null;
	Status: string;
	Priority: string | null;
	CreatedDate: string;
	LastModifiedDate: string;
	recordTypeName: string | null;
}

export interface CaseDetail extends CaseSummary {
	Description: string | null;
	Origin: string | null;
	Type: string | null;
	AccountId: string | null;
	ContactId: string | null;
	OwnerId: string | null;
	/** Estimated_Revenue_at_Risk__c */
	estimatedRevenueAtRisk: number | null;
	/** ASIN__c — the Amazon listing this case is about, if set. */
	asin: string | null;
}

interface CaseRow {
	Id: string;
	CaseNumber: string;
	Subject: string | null;
	Status: string;
	Priority: string | null;
	CreatedDate: string;
	LastModifiedDate: string;
	RecordType: { Name: string } | null;
}

interface CaseDetailRow extends CaseRow {
	Description: string | null;
	Origin: string | null;
	Type: string | null;
	AccountId: string | null;
	ContactId: string | null;
	OwnerId: string | null;
	Estimated_Revenue_at_Risk__c: number | null;
	ASIN__c: string | null;
}

export interface CaseMessage {
	Id: string;
	body: string | null;
	senderType: string | null;
	senderContactId: string | null;
	/** From Sender_Contact__r.Name — the linked Contact, if any. */
	senderContactName: string | null;
	/** From CreatedBy.Name — the Salesforce User who saved the record. Always present. */
	createdByName: string | null;
	createdById: string | null;
	/**
	 * Best display name for the comment author. Prefers the linked Contact,
	 * falls back to the Salesforce User who created the record. Null only if
	 * both reads were null (shouldn't happen — every SF record has a CreatedBy).
	 */
	displayName: string | null;
	createdAt: string;
	/** Reply_To_Message__c — Id of the message this one replies to, if any. */
	replyToMessageId: string | null;
	/** Message_Read__c — when the recipient read this message, or null if unread. */
	messageRead: string | null;
}

interface CaseMessageRow {
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

function resolveDisplayName(row: CaseMessageRow): string | null {
	return row.Sender_Contact__r?.Name ?? row.CreatedBy?.Name ?? null;
}

// ─── List Cases for a store ─────────────────────────────────────────────

/** Carries the Store__c reference so callers can fan out / join locally. */
export interface CaseSummaryWithStore extends CaseSummary {
	sfdcStoreId: string | null;
}

/**
 * Cases across MULTIPLE stores in one SOQL — used by the account-wide
 * /issues page. Empty input returns an empty result without round-tripping
 * to SF.
 */
export async function listCasesForStores(
	sfdcStoreIds: string[],
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; cases: CaseSummaryWithStore[] } | { ok: false; error: string }> {
	if (sfdcStoreIds.length === 0) return { ok: true, cases: [] };
	if (sfdcStoreIds.length > 200) {
		// SOQL IN clauses cap somewhere around 500 literals; keep headroom.
		return { ok: false, error: 'Too many stores for a single query (max 200).' };
	}
	const literals = sfdcStoreIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
	const soql = `
		SELECT Id, CaseNumber, Subject, Status, Priority,
		       CreatedDate, LastModifiedDate, RecordType.Name,
		       ${CASE_STORE_FIELD}
		FROM Case
		WHERE ${CASE_STORE_FIELD} IN (${literals})
		ORDER BY CreatedDate DESC
		LIMIT 1000
	`.trim();
	try {
		const result = await sfdcQuery<CaseRow & { Store__c: string | null }>(
			soql,
			{ paginate: true }
		);
		const cases = result.records.map(
			(r): CaseSummaryWithStore => ({
				Id: r.Id,
				CaseNumber: r.CaseNumber,
				Subject: r.Subject,
				Status: r.Status,
				Priority: r.Priority,
				CreatedDate: r.CreatedDate,
				LastModifiedDate: r.LastModifiedDate,
				recordTypeName: r.RecordType?.Name ?? null,
				sfdcStoreId: r.Store__c
			})
		);
		return { ok: true, cases };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'list_for_stores',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcStoreCount: sfdcStoreIds.length }
		});
		return { ok: false, error: errorMessage };
	}
}

export async function listCasesForStore(
	sfdcStoreId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; cases: CaseSummary[] } | { ok: false; error: string }> {
	const escaped = sfdcStoreId.replace(/'/g, "''");
	const soql = `
		SELECT Id, CaseNumber, Subject, Status, Priority,
		       CreatedDate, LastModifiedDate, RecordType.Name
		FROM Case
		WHERE ${CASE_STORE_FIELD} = '${escaped}'
		ORDER BY CreatedDate DESC
		LIMIT 500
	`.trim();
	try {
		const result = await sfdcQuery<CaseRow>(soql, { paginate: true });
		const cases = result.records.map(
			(r): CaseSummary => ({
				Id: r.Id,
				CaseNumber: r.CaseNumber,
				Subject: r.Subject,
				Status: r.Status,
				Priority: r.Priority,
				CreatedDate: r.CreatedDate,
				LastModifiedDate: r.LastModifiedDate,
				recordTypeName: r.RecordType?.Name ?? null
			})
		);
		return { ok: true, cases };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'list_for_store',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcStoreId }
		});
		return { ok: false, error: errorMessage };
	}
}

// ─── Single Case detail ─────────────────────────────────────────────────

export async function fetchCase(
	caseId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; record: CaseDetail } | { ok: false; error: string; notFound?: boolean }> {
	const fields = [
		'Id', 'CaseNumber', 'Subject', 'Status', 'Priority',
		'CreatedDate', 'LastModifiedDate', 'Description', 'Origin',
		'Type', 'AccountId', 'ContactId', 'OwnerId', 'Estimated_Revenue_at_Risk__c', 'ASIN__c'
	];
	const escaped = caseId.replace(/'/g, "''");
	try {
		// Use SOQL so we can pull RecordType.Name in one trip.
		const soql = `
			SELECT ${fields.join(', ')}, RecordType.Name
			FROM Case WHERE Id = '${escaped}' LIMIT 1
		`.trim();
		const result = await sfdcQuery<CaseDetailRow>(soql);
		const row = result.records[0];
		if (!row) return { ok: false, error: 'Case not found in Salesforce.', notFound: true };
		return {
			ok: true,
			record: {
				Id: row.Id,
				CaseNumber: row.CaseNumber,
				Subject: row.Subject,
				Status: row.Status,
				Priority: row.Priority,
				CreatedDate: row.CreatedDate,
				LastModifiedDate: row.LastModifiedDate,
				recordTypeName: row.RecordType?.Name ?? null,
				Description: row.Description,
				Origin: row.Origin,
				Type: row.Type,
				AccountId: row.AccountId,
				ContactId: row.ContactId,
				OwnerId: row.OwnerId,
				estimatedRevenueAtRisk: row.Estimated_Revenue_at_Risk__c,
				asin: row.ASIN__c
			}
		};
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const notFound = isSfErr && e.status === 404;
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'fetch_case',
			severity: notFound ? 'warn' : 'error',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Case',
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseId }
		});
		return { ok: false, error: errorMessage, notFound };
	}
}

/** PATCH Case.Estimated_Revenue_at_Risk__c — used by the SP-API-driven recalculation. */
export async function updateCaseEstimatedRevenueAtRisk(
	caseId: string,
	amount: number,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string; errorCode?: string }> {
	try {
		await sobjectUpdate('Case', caseId, { Estimated_Revenue_at_Risk__c: amount });
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.cases',
			operation: 'update_estimated_revenue_at_risk',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Case',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseId, amount }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/**
 * Lightweight lookup — returns just `{ Id, sfdcStoreId }` so deep links can
 * route a SF Case Id back to the local store URL without paying for the full
 * fetchCase round trip. Used by the /cases/<sfdcCaseId> shortcut.
 */
export async function findCaseStoreLookup(
	caseId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<
	| { ok: true; sfdcCaseId: string; sfdcStoreId: string | null }
	| { ok: false; error: string; notFound?: boolean }
> {
	const escaped = caseId.replace(/'/g, "''");
	const soql = `SELECT Id, ${CASE_STORE_FIELD} FROM Case WHERE Id = '${escaped}' LIMIT 1`;
	try {
		const result = await sfdcQuery<{ Id: string; Store__c: string | null }>(soql);
		const row = result.records[0];
		if (!row) return { ok: false, error: 'Case not found.', notFound: true };
		return { ok: true, sfdcCaseId: row.Id, sfdcStoreId: row.Store__c };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const notFound = isSfErr && e.status === 404;
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'find_case_store_lookup',
			severity: notFound ? 'warn' : 'error',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Case',
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseId }
		});
		return { ok: false, error: errorMessage, notFound };
	}
}

// ─── Case messages (comments) ───────────────────────────────────────────

export async function listCaseMessages(
	caseId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; messages: CaseMessage[] } | { ok: false; error: string }> {
	const escaped = caseId.replace(/'/g, "''");
	const senderContactRel = CM_FIELDS.senderContact.replace('__c', '__r');
	const soql = `
		SELECT Id, ${CM_FIELDS.body}, ${CM_FIELDS.senderType},
		       ${CM_FIELDS.senderContact}, ${senderContactRel}.Name,
		       CreatedById, CreatedBy.Name,
		       CreatedDate, ${CM_FIELDS.replyTo}, ${CM_FIELDS.read}
		FROM Case_Message__c
		WHERE ${CM_CASE_FIELD} = '${escaped}'
		ORDER BY CreatedDate ASC
		LIMIT 500
	`.trim();
	try {
		const result = await sfdcQuery<CaseMessageRow>(soql, { paginate: true });
		const messages = result.records.map(
			(r): CaseMessage => ({
				Id: r.Id,
				body: r.Message_Body__c,
				senderType: r.Sender_Type__c,
				senderContactId: r.Sender_Contact__c,
				senderContactName: r.Sender_Contact__r?.Name ?? null,
				createdById: r.CreatedById,
				createdByName: r.CreatedBy?.Name ?? null,
				displayName: resolveDisplayName(r),
				createdAt: r.CreatedDate,
				replyToMessageId: r.Reply_To_Message__c,
				messageRead: r.Message_Read__c
			})
		);
		return { ok: true, messages };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'list_messages',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseId }
		});
		return { ok: false, error: errorMessage };
	}
}

export async function createCaseMessage(
	args: {
		caseId: string;
		senderContactId: string;
		body: string;
		replyToMessageId?: string | null;
	},
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; id: string } | { ok: false; error: string; errorCode?: string }> {
	const payload: Record<string, unknown> = {
		[CM_CASE_FIELD]: args.caseId,
		[CM_FIELDS.senderContact]: args.senderContactId,
		[CM_FIELDS.body]: args.body,
		[CM_FIELDS.senderType]: SENDER_TYPE_EXTERNAL
	};
	if (args.replyToMessageId) payload[CM_FIELDS.replyTo] = args.replyToMessageId;
	try {
		const created = await sobjectCreate('Case_Message__c', payload);
		if (!created.success) {
			const error = `Salesforce Case_Message__c create returned success=false: ${JSON.stringify(created.errors)}`;
			await logError({
				source: 'salesforce.cases',
				operation: 'create_message',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: 'Case_Message__c',
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
			source: 'salesforce.cases',
			operation: 'create_message',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Case_Message__c',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { payload }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

/**
 * PATCH Case_Message__c.Message_Read__c to now. Idempotent — call it whenever
 * the recipient views the message; re-marking an already-read message just
 * bumps the timestamp.
 */
export async function markCaseMessageRead(
	messageId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string; errorCode?: string }> {
	try {
		await sobjectUpdate('Case_Message__c', messageId, {
			[CM_FIELDS.read]: new Date().toISOString()
		});
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.cases',
			operation: 'mark_message_read',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: 'Case_Message__c',
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { messageId }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}

// Re-export sobjectGet for callers that want to fetch other related objects.
export { sobjectGet };

// ─── Cross-case helpers (dashboard rollups) ─────────────────────────────

export interface RecentCaseMessage extends CaseMessage {
	caseId: string;
	caseNumber: string;
}

/**
 * Recent Case_Message__c rows across MANY cases — for the account-wide
 * dashboard. Empty input → empty result, no round-trip.
 */
export async function listRecentMessagesForCases(
	caseIds: string[],
	limit: number,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; messages: RecentCaseMessage[] } | { ok: false; error: string }> {
	if (caseIds.length === 0) return { ok: true, messages: [] };
	const cleanLimit = Math.max(1, Math.min(50, limit | 0));
	const literals = caseIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
	const senderContactRel = CM_FIELDS.senderContact.replace('__c', '__r');
	const soql = `
		SELECT Id, ${CM_FIELDS.body}, ${CM_FIELDS.senderType},
		       ${CM_FIELDS.senderContact}, ${senderContactRel}.Name,
		       CreatedById, CreatedBy.Name,
		       ${CM_CASE_FIELD}, ${CM_CASE_FIELD.replace('__c', '__r')}.CaseNumber,
		       CreatedDate, ${CM_FIELDS.replyTo}, ${CM_FIELDS.read}
		FROM Case_Message__c
		WHERE ${CM_CASE_FIELD} IN (${literals})
		ORDER BY CreatedDate DESC
		LIMIT ${cleanLimit}
	`.trim();
	try {
		const result = await sfdcQuery<
			CaseMessageRow & {
				Case__c: string;
				Case__r: { CaseNumber: string } | null;
			}
		>(soql);
		const messages = result.records.map(
			(r): RecentCaseMessage => ({
				Id: r.Id,
				body: r.Message_Body__c,
				senderType: r.Sender_Type__c,
				senderContactId: r.Sender_Contact__c,
				senderContactName: r.Sender_Contact__r?.Name ?? null,
				createdById: r.CreatedById,
				createdByName: r.CreatedBy?.Name ?? null,
				displayName: resolveDisplayName(r),
				createdAt: r.CreatedDate,
				replyToMessageId: r.Reply_To_Message__c,
				messageRead: r.Message_Read__c,
				caseId: r.Case__c,
				caseNumber: r.Case__r?.CaseNumber ?? ''
			})
		);
		return { ok: true, messages };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'list_recent_messages_for_cases',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseCount: caseIds.length }
		});
		return { ok: false, error: errorMessage };
	}
}

export interface PendingCaseFile extends CaseFile {
	caseId: string;
	caseNumber: string;
}

/**
 * Pending Case_File__c rows (Client_File_Info__c empty) across MANY cases.
 *
 * NOTE: Salesforce won't let us filter Long Text Area fields in SOQL
 * (`field 'Client_File_Info__c' can not be filtered in a query call`), so
 * we pull ALL case-file rows for the given cases and partition them in JS.
 *
 * Returns:
 *   - `files`: pending rows, newest-first, sliced to `limit`
 *   - `total`: total pending count (regardless of `limit`) — for stat cards
 */
export async function listPendingFilesForCases(
	caseIds: string[],
	limit: number,
	context: { userId?: string; accountId?: string } = {}
): Promise<
	| { ok: true; files: PendingCaseFile[]; total: number }
	| { ok: false; error: string }
> {
	if (caseIds.length === 0) return { ok: true, files: [], total: 0 };
	const cleanLimit = Math.max(1, Math.min(50, limit | 0));
	const literals = caseIds.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
	const caseRel = CASE_FILE_FIELDS.case.replace('__c', '__r');
	// No WHERE filter on Client_File_Info__c — partition client-side instead.
	const soql = `
		SELECT Id, Name, ${CASE_FILE_FIELDS.shortDescription},
		       ${CASE_FILE_FIELDS.clientFileInfo},
		       ${CASE_FILE_FIELDS.case}, ${caseRel}.CaseNumber,
		       CreatedDate
		FROM ${CASE_FILE_OBJECT}
		WHERE ${CASE_FILE_FIELDS.case} IN (${literals})
		ORDER BY CreatedDate DESC
	`.trim();
	try {
		const result = await sfdcQuery<
			CaseFileRow & {
				Case__c: string;
				Case__r: { CaseNumber: string } | null;
			}
		>(soql, { paginate: true });

		const pending = result.records.filter(
			(r) => !r.Client_File_Info__c || r.Client_File_Info__c.trim() === ''
		);

		const files = pending.slice(0, cleanLimit).map(
			(r): PendingCaseFile => ({
				Id: r.Id,
				Name: r.Name,
				shortDescription: r.Short_Description__c,
				clientFileInfo: r.Client_File_Info__c,
				createdAt: r.CreatedDate,
				caseId: r.Case__c,
				caseNumber: r.Case__r?.CaseNumber ?? ''
			})
		);
		return { ok: true, files, total: pending.length };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'list_pending_files_for_cases',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseCount: caseIds.length }
		});
		return { ok: false, error: errorMessage };
	}
}

// ─── Case_File__c (required-file checklist) ─────────────────────────────

export interface CaseFile {
	Id: string;
	Name: string;
	shortDescription: string | null;
	clientFileInfo: string | null;     // populated when the client uploads
	createdAt: string;
}

interface CaseFileRow {
	Id: string;
	Name: string;
	Short_Description__c: string | null;
	Client_File_Info__c: string | null;
	CreatedDate: string;
}

/**
 * List the required-file slots for a Case. These are admin-defined in
 * Salesforce (one Case_File__c per file the client must submit). The
 * `clientFileInfo` field is populated by us once the user uploads.
 */
export async function listCaseFiles(
	caseId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; files: CaseFile[] } | { ok: false; error: string }> {
	const escaped = caseId.replace(/'/g, "''");
	const soql = `
		SELECT Id, Name, ${CASE_FILE_FIELDS.shortDescription}, ${CASE_FILE_FIELDS.clientFileInfo}, CreatedDate
		FROM ${CASE_FILE_OBJECT}
		WHERE ${CASE_FILE_FIELDS.case} = '${escaped}'
		ORDER BY Name ASC
		LIMIT 200
	`.trim();
	try {
		const result = await sfdcQuery<CaseFileRow>(soql, { paginate: true });
		const files = result.records.map(
			(r): CaseFile => ({
				Id: r.Id,
				Name: r.Name,
				shortDescription: r.Short_Description__c,
				clientFileInfo: r.Client_File_Info__c,
				createdAt: r.CreatedDate
			})
		);
		return { ok: true, files };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'list_case_files',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseId }
		});
		return { ok: false, error: errorMessage };
	}
}

/**
 * List the required-file slots for a STORE — same Case_File__c object as the
 * case-level checklist, just filtered to records where Store__c = <id> AND
 * Case__c is null (store-level documents, not tied to a specific case).
 */
export async function listStoreFiles(
	sfdcStoreId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; files: CaseFile[] } | { ok: false; error: string }> {
	const escaped = sfdcStoreId.replace(/'/g, "''");
	const soql = `
		SELECT Id, Name, ${CASE_FILE_FIELDS.shortDescription}, ${CASE_FILE_FIELDS.clientFileInfo}, CreatedDate
		FROM ${CASE_FILE_OBJECT}
		WHERE ${CASE_FILE_FIELDS.store} = '${escaped}'
		  AND ${CASE_FILE_FIELDS.case} = null
		ORDER BY Name ASC
		LIMIT 200
	`.trim();
	try {
		const result = await sfdcQuery<CaseFileRow>(soql, { paginate: true });
		const files = result.records.map(
			(r): CaseFile => ({
				Id: r.Id,
				Name: r.Name,
				shortDescription: r.Short_Description__c,
				clientFileInfo: r.Client_File_Info__c,
				createdAt: r.CreatedDate
			})
		);
		return { ok: true, files };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'list_store_files',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { sfdcStoreId }
		});
		return { ok: false, error: errorMessage };
	}
}

// ─── Case history + timeline ────────────────────────────────────────────

export interface CaseHistoryEntry {
	Id: string;
	field: string;
	oldValue: string | null;
	newValue: string | null;
	createdAt: string;
	createdByName: string | null;
}

interface CaseHistoryRow {
	Id: string;
	Field: string;
	OldValue: string | null;
	NewValue: string | null;
	CreatedDate: string;
	CreatedBy: { Name: string } | null;
}

const HISTORY_FIELD_LABELS: Record<string, string> = {
	Status: 'Status',
	Priority: 'Priority',
	Owner: 'Owner',
	Subject: 'Subject',
	Description: 'Description',
	Type: 'Type',
	Origin: 'Origin',
	Contact: 'Contact',
	Account: 'Account'
};

function looksLikeSfId(value: string): boolean {
	return /^[a-zA-Z0-9]{15,18}$/.test(value);
}

function formatHistoryValue(field: string, value: string | null): string | null {
	if (!value) return null;
	if (looksLikeSfId(value) && (field === 'Owner' || field.endsWith('Id'))) return null;
	return value;
}

function historyEventType(field: string): CaseTimelineEventType {
	if (field === 'Status') return 'status_changed';
	if (field === 'Priority') return 'priority_changed';
	if (field === 'Owner' || field === 'ownerAssignment') return 'owner_changed';
	return 'field_changed';
}

function formatHistoryText(entry: CaseHistoryEntry): string {
	const field = entry.field;
	if (field === 'created') return 'Case opened';

	const label = HISTORY_FIELD_LABELS[field] ?? field.replace(/([A-Z])/g, ' $1').trim();
	const oldVal = formatHistoryValue(field, entry.oldValue);
	const newVal = formatHistoryValue(field, entry.newValue);

	if (field === 'ownerAssignment') {
		return newVal ? `Case assigned — ${newVal}` : 'Case owner assigned';
	}
	if (oldVal && newVal) return `${label} changed from ${oldVal} to ${newVal}`;
	if (newVal) return `${label} set to ${newVal}`;
	if (oldVal) return `${label} cleared (was ${oldVal})`;
	return `${label} updated`;
}

export interface CaseTimelineFileInput {
	caseFileId: string;
	name: string;
	createdAt: string;
	upload: { id: string; originalName: string; createdAt: string } | null;
}

/** Merge SF CaseHistory, comments, and document activity into one timeline. */
export function buildCaseTimeline(args: {
	caseRecord: Pick<CaseDetail, 'CreatedDate'>;
	messages: CaseMessage[];
	requiredFiles: CaseTimelineFileInput[];
	history: CaseHistoryEntry[];
}): CaseTimelineEvent[] {
	const events: CaseTimelineEvent[] = [];
	let hasCreatedHistory = false;

	for (const h of args.history) {
		if (h.field === 'created') hasCreatedHistory = true;
		events.push({
			id: `history-${h.Id}`,
			type: h.field === 'created' ? 'case_opened' : historyEventType(h.field),
			date: h.createdAt,
			text: formatHistoryText(h),
			actor: h.createdByName,
			detail: null
		});
	}

	if (!hasCreatedHistory) {
		events.push({
			id: 'case-opened',
			type: 'case_opened',
			date: args.caseRecord.CreatedDate,
			text: 'Case opened',
			actor: null,
			detail: null
		});
	}

	for (const m of args.messages) {
		const actor = m.displayName ?? m.senderContactName ?? m.createdByName ?? 'Unknown';
		events.push({
			id: `message-${m.Id}`,
			type: 'comment_added',
			date: m.createdAt,
			text: `Comment added by ${actor}`,
			actor,
			detail: m.body ? truncate(m.body, 120) : null
		});
	}

	for (const f of args.requiredFiles) {
		events.push({
			id: `file-request-${f.caseFileId}`,
			type: 'document_requested',
			date: f.createdAt,
			text: `Document requested — ${f.name}`,
			actor: null,
			detail: null
		});
		if (f.upload) {
			events.push({
				id: `file-upload-${f.caseFileId}-${f.upload.id}`,
				type: 'document_uploaded',
				date: f.upload.createdAt,
				text: `Document uploaded — ${f.name}`,
				actor: null,
				detail: f.upload.originalName
			});
		}
	}

	return events.sort(
		(a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
	);
}

function truncate(text: string, max: number): string {
	const trimmed = text.trim();
	if (trimmed.length <= max) return trimmed;
	return `${trimmed.slice(0, max - 1)}…`;
}

export async function listCaseHistory(
	caseId: string,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true; history: CaseHistoryEntry[] } | { ok: false; error: string }> {
	const escaped = caseId.replace(/'/g, "''");
	const soql = `
		SELECT Id, Field, OldValue, NewValue, CreatedDate, CreatedBy.Name
		FROM CaseHistory
		WHERE CaseId = '${escaped}'
		ORDER BY CreatedDate DESC
		LIMIT 500
	`.trim();
	try {
		const result = await sfdcQuery<CaseHistoryRow>(soql, { paginate: true });
		const history = result.records.map(
			(r): CaseHistoryEntry => ({
				Id: r.Id,
				field: r.Field,
				oldValue: r.OldValue,
				newValue: r.NewValue,
				createdAt: r.CreatedDate,
				createdByName: r.CreatedBy?.Name ?? null
			})
		);
		return { ok: true, history };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.cases',
			operation: 'list_case_history',
			userId: context.userId,
			accountId: context.accountId,
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseId }
		});
		return { ok: false, error: errorMessage };
	}
}

/**
 * PATCH the Client_File_Info__c field on a Case_File__c. Passing null clears
 * the field (treats the slot as pending again).
 */
export async function updateCaseFile(
	caseFileId: string,
	clientFileInfo: string | null,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string; errorCode?: string }> {
	const payload = { [CASE_FILE_FIELDS.clientFileInfo]: clientFileInfo } as Record<string, unknown>;
	try {
		await sobjectUpdate(CASE_FILE_OBJECT, caseFileId, payload);
		return { ok: true };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.cases',
			operation: 'update_case_file',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: CASE_FILE_OBJECT,
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: { caseFileId, clientFileInfo }
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}
