/**
 * S3_Document__c — the canonical file registry in Salesforce.
 *
 * Each row links one S3 object to any Salesforce record (Case, Store__c, …)
 * via the polymorphic Related_Record_Id__c / Related_Object_Type__c pair, and
 * powers the `s3DocumentViewer` LWC (list / preview / download).
 *
 * After every successful S3 upload the app creates an S3_Document__c here — in
 * ADDITION to any object-specific workflow record (e.g. Case_File__c, which
 * still carries verification / document-type fields). Best-effort: a failure
 * is logged and surfaced, but never rolls back the S3 object or local row.
 *
 * Read-only formula fields (Is_Previewable__c, Preview_Type__c) and the
 * presigned-URL cache fields are NEVER set here — Salesforce derives the first,
 * and the /api/files/presigned-url endpoint refreshes the second on demand.
 */
import { sobjectCreate, SalesforceApiError } from './client';
import { logError } from '$lib/server/error_log';

const S3_DOCUMENT_OBJECT = 'S3_Document__c';

export interface S3DocumentInput {
	relatedRecordId: string; // SF record Id — Case Id, Store__c Id, …
	relatedObjectType: string; // 'Case' | 'Store__c' | …
	bucket: string;
	key: string; // full S3 object key
	region: string;
	fileName: string;
	contentType?: string | null; // MIME type
	sizeBytes?: number;
	description?: string | null;
	uploadedDate?: Date; // defaults to now
}

export type S3DocumentResult =
	| { ok: true; id: string }
	| { ok: false; error: string; errorCode?: string };

/** Lowercased extension without the dot, or undefined if the name has none. */
function fileExtension(name: string): string | undefined {
	const i = name.lastIndexOf('.');
	if (i <= 0 || i === name.length - 1) return undefined;
	return name.slice(i + 1).toLowerCase();
}

/**
 * Create one S3_Document__c for a just-uploaded file. Best-effort: returns a
 * result object instead of throwing, so callers can surface a partial-success
 * message without failing the upload.
 */
export async function createS3Document(
	input: S3DocumentInput,
	context: { userId?: string; accountId?: string } = {}
): Promise<S3DocumentResult> {
	const payload: Record<string, unknown> = {
		// Polymorphic link (required)
		Related_Record_Id__c: input.relatedRecordId,
		Related_Object_Type__c: input.relatedObjectType,
		// S3 storage (required)
		S3_Bucket__c: input.bucket,
		S3_Key__c: input.key,
		S3_Region__c: input.region,
		File_Name__c: input.fileName,
		Status__c: 'Active',
		// Metadata (recommended)
		Uploaded_Date__c: (input.uploadedDate ?? new Date()).toISOString()
	};
	const ext = fileExtension(input.fileName);
	if (ext) payload.File_Extension__c = ext;
	if (input.contentType) payload.Content_Type__c = input.contentType;
	if (typeof input.sizeBytes === 'number') payload.File_Size_Bytes__c = input.sizeBytes;
	if (input.description) payload.Description__c = input.description;

	try {
		const created = await sobjectCreate(S3_DOCUMENT_OBJECT, payload);
		if (!created.success) {
			const error = `S3_Document__c create returned success=false: ${JSON.stringify(created.errors)}`;
			await logError({
				source: 'salesforce.s3_documents',
				operation: 'create',
				userId: context.userId,
				accountId: context.accountId,
				sfdcObject: S3_DOCUMENT_OBJECT,
				errorMessage: error,
				context: { key: input.key, relatedRecordId: input.relatedRecordId }
			});
			return { ok: false, error };
		}
		return { ok: true, id: created.id };
	} catch (e) {
		const isSfErr = e instanceof SalesforceApiError;
		const errorMessage = e instanceof Error ? e.message : String(e);
		const errorCode = isSfErr ? e.errorCode : undefined;
		await logError({
			source: 'salesforce.s3_documents',
			operation: 'create',
			userId: context.userId,
			accountId: context.accountId,
			sfdcObject: S3_DOCUMENT_OBJECT,
			errorCode: errorCode ?? (isSfErr ? String(e.status) : undefined),
			errorMessage,
			stack: e instanceof Error ? e.stack : undefined,
			context: {
				key: input.key,
				relatedRecordId: input.relatedRecordId,
				relatedObjectType: input.relatedObjectType
			}
		});
		return { ok: false, error: errorMessage, errorCode };
	}
}
