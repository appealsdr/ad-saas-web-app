/**
 * Finding and handing out the files of a Required_File__c slot — shared by /api/v1 and MCP.
 *
 * The caller must already have verified that the slot belongs to the store or case (requireIntegration*RequiredFile).
 * Only ids are taken from the request; S3 keys come from Salesforce or our own rows.
 */
import { sql } from '../db';
import { ApiError } from '../integrations/errors';
import { getDownloadUrl, DOWNLOAD_URL_TTL_SECONDS } from '../storage/s3';
import { logError, describeError } from '../error_log';
import type { RequiredFile } from '../salesforce';
import { resolveContentType, type Disposition } from './content_headers';

export type SlotFileKind = 'upload' | 'example';

export type SlotFile = { fileName: string; contentType: string } & (
	| { source: 's3'; key: string }
	/** Legacy upload kept on local disk; `documentId` is its store_documents row. */
	| { source: 'disk'; storagePath: string; documentId: string }
);

export interface SlotRef {
	storeId: string;
	/** Omit for a store-level slot. */
	caseId?: string;
	slot: RequiredFile;
}

const notFound = (kind: SlotFileKind) =>
	new ApiError(404, 'FILE_NOT_FOUND', kind === 'example' ? 'This slot has no example file.' : 'This slot has no uploaded file.');

const s3File = (key: string, fileName: string, contentType: string | null): SlotFile => ({
	source: 's3', key, fileName, contentType: resolveContentType(contentType, fileName)
});

/**
 * The example comes from the slot's template. The upload is the slot's current version in Salesforce (which also
 * covers files added there, with no local row); without one, the newest local row for the slot.
 */
export async function findSlotFile(ref: SlotRef, kind: SlotFileKind): Promise<SlotFile> {
	const version = kind === 'example' ? ref.slot.example : ref.slot.upload;
	if (version?.s3Key) return s3File(version.s3Key, version.fileName, version.contentType);
	if (kind === 'example') throw notFound(kind);

	const [row] = ref.caseId
		? await sql<LocalRow[]>`
			SELECT id, original_name, mime_type, s3_key, NULL::text AS storage_path FROM case_documents
			WHERE store_id = ${ref.storeId} AND sfdc_case_id = ${ref.caseId} AND sfdc_case_file_id = ${ref.slot.id}
			ORDER BY created_at DESC, id LIMIT 1`
		: await sql<LocalRow[]>`
			SELECT id, original_name, mime_type, s3_key, storage_path FROM store_documents
			WHERE store_id = ${ref.storeId} AND sfdc_case_file_id = ${ref.slot.id}
			ORDER BY created_at DESC, id LIMIT 1`;
	if (row?.s3_key) return s3File(row.s3_key, row.original_name, row.mime_type);
	if (row?.storage_path) {
		return {
			source: 'disk', storagePath: row.storage_path, documentId: row.id, fileName: row.original_name,
			contentType: resolveContentType(row.mime_type, row.original_name)
		};
	}
	throw notFound(kind);
}

interface LocalRow { id: string; original_name: string; mime_type: string | null; s3_key: string | null; storage_path: string | null }

/** A short-lived presigned URL. The URL is a credential: never log it. */
export async function presignSlotFile(
	file: Extract<SlotFile, { source: 's3' }>,
	disposition: Disposition,
	context: { accountId: string; requiredFileId: string }
): Promise<{ url: string; expiresAt: Date }> {
	// Taken before signing, so the stated expiry is never later than the real one.
	const expiresAt = new Date(Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000);
	try {
		return { url: await getDownloadUrl(file.key, file.fileName, { disposition, contentType: file.contentType }), expiresAt };
	} catch (e) {
		const d = describeError(e);
		await logError({ source: 'api.v1', operation: 'required_files.presign', accountId: context.accountId, errorMessage: d.errorMessage, stack: d.stack, context: { requiredFileId: context.requiredFileId } });
		throw new ApiError(502, 'UPSTREAM_ERROR', 'Could not prepare the download right now.');
	}
}
