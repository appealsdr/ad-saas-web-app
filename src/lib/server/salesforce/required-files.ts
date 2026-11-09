/**
 * Required_File__c — a file the client must upload, on a Case or a Store.
 * Replaces the old Case_File__c checklist. Seeded from Document_Template__c.
 *
 * Relationships used here:
 *   Required_File__c.Last_Version__r            → S3_Document__c (the uploaded file)
 *   Required_File__c.Document_Template__r
 *        .Last_Version__r                       → S3_Document__c (an example to download)
 *
 * Upload flow: put bytes to S3 → create S3_Document__c (Related_Record_Id__c =
 * the Case/Store SF Id) → set Required_File__c.Last_Version__c + File_Uploaded__c.
 */
import { sfdcQuery, sobjectUpdate, SalesforceApiError } from './client';
import { createS3Document } from './s3-documents';
import { logError } from '$lib/server/error_log';

const REQUIRED_FILE_OBJECT = 'Required_File__c';

// ── Types exposed to the app ────────────────────────────────────────────

export interface RequiredFileVersion {
	s3DocumentId: string;
	fileName: string;
	fileExtension: string | null;
	contentType: string | null;
	s3Key: string | null;
	s3Bucket: string | null;
	uploadedDate: string | null;
}

export interface RequiredFile {
	id: string;
	name: string;
	shortDescription: string | null;
	instructions: string | null; // rich-text HTML
	acceptedFormats: string[]; // e.g. ['pdf','doc','docx']
	createdAt: string;
	uploaded: boolean;
	upload: RequiredFileVersion | null; // current uploaded file (Last_Version__r)
	example: RequiredFileVersion | null; // template example (Document_Template__r.Last_Version__r)
}

// ── Raw SF row shape (relationship fields flattened by the API) ─────────

interface SfDocRel {
	Id?: string;
	File_Name__c?: string | null;
	File_Extension__c?: string | null;
	Content_Type__c?: string | null;
	S3_Key__c?: string | null;
	S3_Bucket__c?: string | null;
	Uploaded_Date__c?: string | null;
}
interface RequiredFileRow {
	Id: string;
	Name: string;
	Short_Description__c: string | null;
	Instructions__c: string | null;
	Accepted_Format__c: string | null; // multi-select → "pdf;doc;docx"
	CreatedDate: string;
	File_Uploaded__c: boolean | null;
	Last_Version__c: string | null;
	Last_Version__r: SfDocRel | null;
	Document_Template__r: { Last_Version__c?: string | null; Last_Version__r?: SfDocRel | null } | null;
}

const SELECT_FIELDS = `
	Id, Name, Short_Description__c, Instructions__c, Accepted_Format__c, CreatedDate, File_Uploaded__c,
	Last_Version__c,
	Last_Version__r.Id, Last_Version__r.File_Name__c, Last_Version__r.File_Extension__c,
	Last_Version__r.Content_Type__c, Last_Version__r.S3_Key__c, Last_Version__r.S3_Bucket__c,
	Last_Version__r.Uploaded_Date__c,
	Document_Template__r.Last_Version__c,
	Document_Template__r.Last_Version__r.Id, Document_Template__r.Last_Version__r.File_Name__c,
	Document_Template__r.Last_Version__r.File_Extension__c, Document_Template__r.Last_Version__r.Content_Type__c,
	Document_Template__r.Last_Version__r.S3_Key__c, Document_Template__r.Last_Version__r.S3_Bucket__c
`.trim();

function parseFormats(raw: string | null): string[] {
	if (!raw) return [];
	return raw
		.split(';')
		.map((s) => s.trim().replace(/^\./, '').toLowerCase())
		.filter(Boolean);
}

function toVersion(doc: SfDocRel | null | undefined): RequiredFileVersion | null {
	if (!doc?.Id) return null;
	return {
		s3DocumentId: doc.Id,
		fileName: doc.File_Name__c ?? 'file',
		fileExtension: doc.File_Extension__c ?? null,
		contentType: doc.Content_Type__c ?? null,
		s3Key: doc.S3_Key__c ?? null,
		s3Bucket: doc.S3_Bucket__c ?? null,
		uploadedDate: doc.Uploaded_Date__c ?? null
	};
}

function mapRow(r: RequiredFileRow): RequiredFile {
	const upload = toVersion(r.Last_Version__r);
	return {
		id: r.Id,
		name: r.Name,
		shortDescription: r.Short_Description__c,
		instructions: r.Instructions__c,
		acceptedFormats: parseFormats(r.Accepted_Format__c),
		createdAt: r.CreatedDate,
		uploaded: !!r.File_Uploaded__c || !!upload,
		upload,
		example: r.Document_Template__r?.Last_Version__c
			? toVersion(r.Document_Template__r.Last_Version__r)
			: null
	};
}

type ListResult = { ok: true; files: RequiredFile[] } | { ok: false; error: string };

async function listBy(field: 'Case__c' | 'Store__c', sfId: string): Promise<ListResult> {
	const escaped = sfId.replace(/'/g, "''");
	const soql = `SELECT ${SELECT_FIELDS} FROM ${REQUIRED_FILE_OBJECT} WHERE ${field} = '${escaped}' ORDER BY Name ASC LIMIT 200`;
	try {
		const result = await sfdcQuery<RequiredFileRow>(soql);
		return { ok: true, files: result.records.map(mapRow) };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.required_files',
			operation: 'list',
			sfdcObject: REQUIRED_FILE_OBJECT,
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage,
			context: { field, sfId }
		});
		return { ok: false, error: errorMessage };
	}
}

/** Required files on a Case (issue context). */
export function listRequiredFilesForCase(caseId: string): Promise<ListResult> {
	return listBy('Case__c', caseId);
}

/** Required files on a Store. */
export function listRequiredFilesForStore(sfdcStoreId: string): Promise<ListResult> {
	return listBy('Store__c', sfdcStoreId);
}

// ── Batch variants (one SOQL across many parents) ───────────────────────
// Used by the dashboard to roll up required files across every store/case
// without firing one query per parent. Each row carries its parent Id so the
// caller can group/link it back.

export interface RequiredFileWithParent extends RequiredFile {
	parentId: string; // the Case__c or Store__c lookup value this slot belongs to
}

type BatchListResult =
	| { ok: true; files: RequiredFileWithParent[] }
	| { ok: false; error: string };

async function listByIn(field: 'Case__c' | 'Store__c', ids: string[]): Promise<BatchListResult> {
	if (ids.length === 0) return { ok: true, files: [] };
	const literals = ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(',');
	const soql = `SELECT ${field}, ${SELECT_FIELDS} FROM ${REQUIRED_FILE_OBJECT} WHERE ${field} IN (${literals}) ORDER BY Name ASC LIMIT 1000`;
	try {
		const result = await sfdcQuery<RequiredFileRow & Record<string, unknown>>(soql, {
			paginate: true
		});
		return {
			ok: true,
			files: result.records.map((r) => ({ ...mapRow(r), parentId: String(r[field] ?? '') }))
		};
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.required_files',
			operation: 'list_batch',
			sfdcObject: REQUIRED_FILE_OBJECT,
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage,
			context: { field, idCount: ids.length }
		});
		return { ok: false, error: errorMessage };
	}
}

/** Required files across MANY cases (dashboard rollup). */
export function listRequiredFilesForCases(caseIds: string[]): Promise<BatchListResult> {
	return listByIn('Case__c', caseIds);
}

/** Required files across MANY stores (dashboard rollup). */
export function listRequiredFilesForStores(sfdcStoreIds: string[]): Promise<BatchListResult> {
	return listByIn('Store__c', sfdcStoreIds);
}

// ── Upload / clear ──────────────────────────────────────────────────────

export interface AttachInput {
	requiredFileId: string;
	relatedRecordId: string; // Case SF Id (issue) or Store__c SF Id (store)
	relatedObjectType: string; // 'Case' | 'Store__c'
	bucket: string;
	key: string;
	region: string;
	fileName: string;
	contentType?: string | null;
	sizeBytes?: number;
}

export type AttachResult =
	| { ok: true; s3DocumentId: string }
	| { ok: false; error: string };

/**
 * Create the S3_Document__c for a just-uploaded file and point the
 * Required_File__c at it (Last_Version__c + File_Uploaded__c = true).
 */
export async function attachUploadToRequiredFile(
	input: AttachInput,
	context: { userId?: string; accountId?: string } = {}
): Promise<AttachResult> {
	const doc = await createS3Document(
		{
			relatedRecordId: input.relatedRecordId,
			relatedObjectType: input.relatedObjectType,
			bucket: input.bucket,
			key: input.key,
			region: input.region,
			fileName: input.fileName,
			contentType: input.contentType,
			sizeBytes: input.sizeBytes,
			requiredFileId: input.requiredFileId
		},
		context
	);
	if (!doc.ok) return doc;

	try {
		await sobjectUpdate(REQUIRED_FILE_OBJECT, input.requiredFileId, {
			Last_Version__c: doc.id,
			File_Uploaded__c: true
		});
		return { ok: true, s3DocumentId: doc.id };
	} catch (e) {
		// The S3_Document__c exists; we just couldn't link it. Surface the error.
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.required_files',
			operation: 'attach_version',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: REQUIRED_FILE_OBJECT,
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage,
			context: { requiredFileId: input.requiredFileId, s3DocumentId: doc.id }
		});
		return { ok: false, error: errorMessage };
	}
}

/**
 * Clear the current upload for a Required_File__c: unset Last_Version__c,
 * File_Uploaded__c = false, and mark the old S3_Document__c as Deleted.
 */
export async function clearRequiredFile(
	requiredFileId: string,
	oldS3DocumentId: string | null,
	context: { userId?: string; accountId?: string } = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		await sobjectUpdate(REQUIRED_FILE_OBJECT, requiredFileId, {
			Last_Version__c: null,
			File_Uploaded__c: false
		});
		if (oldS3DocumentId) {
			// Best-effort: tombstone the old registry row.
			try {
				await sobjectUpdate('S3_Document__c', oldS3DocumentId, { Status__c: 'Deleted' });
			} catch {
				/* non-fatal */
			}
		}
		return { ok: true };
	} catch (e) {
		const errorMessage = e instanceof Error ? e.message : String(e);
		await logError({
			source: 'salesforce.required_files',
			operation: 'clear',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: REQUIRED_FILE_OBJECT,
			errorCode: e instanceof SalesforceApiError ? e.errorCode : undefined,
			errorMessage,
			context: { requiredFileId }
		});
		return { ok: false, error: errorMessage };
	}
}
