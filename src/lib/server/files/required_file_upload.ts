/**
 * Programmatic upload into a Required_File__c slot (AD-1969) — used by the public API (and the MCP adapter on top of it).
 *
 * Mirrors the in-app upload actions (S3 → local mirror row → S3_Document__c + Required_File__c.Last_Version__c) but takes
 * ONE raw file and validates it harder, because the caller is a machine:
 *  - size cap, extension ⇄ MIME allow-list, the slot's own accepted formats;
 *  - the real content is sniffed from the bytes (a .pdf that is not a PDF is rejected);
 *  - a slot that already holds a file is only added to with an explicit `replaceExisting` (new version; the old file is kept).
 */
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { sql } from '../db';
import { ApiError } from '../integrations/errors';
import { putObject, deleteObject, getRegion } from '../storage/s3';
import { caseFileKey, storeFileKey } from '../storage/s3-paths';
import { attachUploadToRequiredFile, type RequiredFile } from '../salesforce';
import { logError, describeError } from '../error_log';
import { scanBuffer, scanRequired } from './virus_scan';
import { raiseAlert } from '../security/alerts';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Allowed MIME type → extensions it may carry. */
export const MIME_EXTENSIONS: Record<string, string[]> = {
	'application/pdf': ['pdf'],
	'image/png': ['png'],
	'image/jpeg': ['jpg', 'jpeg'],
	'image/gif': ['gif'],
	'image/webp': ['webp'],
	'image/heic': ['heic'],
	'application/msword': ['doc'],
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
	'application/vnd.ms-excel': ['xls'],
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
	'text/plain': ['txt', 'log'],
	'application/rtf': ['rtf'],
	'text/csv': ['csv'],
	'application/zip': ['zip']
};

export function safeFilename(name: string): string {
	const base = basename(name).replace(/[^\w.\-]/g, '_').slice(-120);
	return base || 'upload';
}

export function extensionOf(name: string): string {
	const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim());
	return m ? m[1].toLowerCase() : '';
}

const normExt = (e: string) => (e === 'jpeg' ? 'jpg' : e);

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);

/** Does the content look like the claimed MIME type? Text types must be NUL-free. */
export function contentMatchesMime(bytes: Uint8Array, mime: string): boolean {
	switch (mime) {
		case 'application/pdf': return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]); // %PDF
		case 'image/png': return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47]);
		case 'image/jpeg': return startsWith(bytes, [0xff, 0xd8, 0xff]);
		case 'image/gif': return startsWith(bytes, [0x47, 0x49, 0x46, 0x38]);
		case 'image/webp': return startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8);
		case 'image/heic': return startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4); // ....ftyp
		case 'application/zip':
		case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
		case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
			return startsWith(bytes, [0x50, 0x4b]); // PK
		case 'application/msword':
		case 'application/vnd.ms-excel':
			return startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0]); // OLE2
		case 'application/rtf': return startsWith(bytes, [0x7b, 0x5c, 0x72, 0x74, 0x66]); // {\rtf
		case 'text/plain':
		case 'text/csv':
			return !bytes.subarray(0, 8192).includes(0);
		default: return false;
	}
}

export interface UploadInput {
	/** MIME type from the request's Content-Type (parameters already stripped). */
	contentType: string;
	fileName: string;
	bytes: Uint8Array;
	replaceExisting: boolean;
}

/** All checks that need no I/O — throws ApiError. Returns the cleaned MIME + extension. */
export function validateUpload(slot: RequiredFile, input: UploadInput): { mime: string; ext: string } {
	const mime = input.contentType.toLowerCase();
	const allowedExts = MIME_EXTENSIONS[mime];
	if (!allowedExts) throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', `File type not allowed: ${mime || '(none)'}.`);
	if (!input.fileName.trim()) throw new ApiError(422, 'VALIDATION_ERROR', 'X-File-Name is required.');
	if (input.fileName.length > 255) throw new ApiError(422, 'VALIDATION_ERROR', 'X-File-Name is too long.');
	if (input.bytes.length === 0) throw new ApiError(422, 'VALIDATION_ERROR', 'The file is empty.');
	if (input.bytes.length > MAX_UPLOAD_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

	const ext = extensionOf(input.fileName);
	if (!allowedExts.includes(ext)) throw new ApiError(422, 'VALIDATION_ERROR', `The file name extension does not match ${mime}.`);
	const accepted = slot.acceptedFormats.map((f) => normExt(f.trim().toLowerCase().replace(/^\./, ''))).filter(Boolean);
	if (accepted.length && !accepted.includes(normExt(ext))) {
		throw new ApiError(422, 'FORMAT_NOT_ACCEPTED', `This slot accepts: ${accepted.join(', ')}.`);
	}
	if (!contentMatchesMime(input.bytes, mime)) throw new ApiError(415, 'CONTENT_MISMATCH', 'The file content does not match its declared type.');
	if (slot.uploaded && !input.replaceExisting) {
		throw new ApiError(409, 'SLOT_ALREADY_UPLOADED', 'This slot already has a file. Send X-Replace-Existing: true to add a new version.');
	}
	return { mime, ext };
}

export interface UploadTarget {
	store: { id: string; account_id: string; sfdc_store_id: string | null };
	/** Set for a case-level slot; omit for a store-level slot. */
	caseId?: string;
	userId: string;
	slot: RequiredFile;
}

export interface UploadResult {
	id: string;
	requiredFileId: string;
	fileName: string;
	contentType: string;
	sizeBytes: number;
	salesforceSynced: boolean;
	salesforceError?: string;
}

export async function storeRequiredFileUpload(t: UploadTarget, input: UploadInput): Promise<UploadResult> {
	const { mime } = validateUpload(t.slot, input);

	// Virus scan BEFORE anything is written. Infected → rejected + alert; scanner down → rejected only when scanning is required.
	const scan = await scanBuffer(input.bytes);
	if (scan.status === 'infected') {
		await raiseAlert({
			kind: 'malware_upload', severity: 'high', accountId: t.store.account_id, subjectType: 'store', subjectId: t.store.id,
			message: `An upload was blocked: malware signature "${scan.signature}" (file name "${input.fileName.slice(0, 80)}").`, dedupeSeconds: 60
		});
		throw new ApiError(422, 'MALWARE_DETECTED', 'The file was rejected because it appears to contain malware.');
	}
	if ((scan.status === 'error' || scan.status === 'skipped') && scanRequired()) {
		if (scan.status === 'error') await logError({ source: 'api.v1', operation: 'required_files.virus_scan', accountId: t.store.account_id, errorMessage: scan.message });
		throw new ApiError(503, 'SCAN_UNAVAILABLE', 'Files cannot be accepted right now because virus scanning is unavailable. Try again later.');
	}
	const docId = randomUUID();
	const filename = safeFilename(input.fileName);
	const key = t.caseId
		? caseFileKey({ accountId: t.store.account_id, storeId: t.store.id, sfdcCaseId: t.caseId, docId, filename })
		: storeFileKey({ accountId: t.store.account_id, storeId: t.store.id, docId, filename });
	const errCtx = { caseId: t.caseId, storeId: t.store.id, requiredFileId: t.slot.id, s3Key: key };

	let bucket: string;
	try {
		bucket = (await putObject(key, Buffer.from(input.bytes), mime)).bucket;
	} catch (e) {
		const d = describeError(e);
		await logError({ source: 'api.v1', operation: 'required_files.s3_put', userId: t.userId, accountId: t.store.account_id, errorMessage: d.errorMessage, stack: d.stack, context: errCtx });
		throw new ApiError(502, 'UPSTREAM_ERROR', 'Could not store the file right now.');
	}

	try {
		if (t.caseId) {
			await sql`
				INSERT INTO case_documents (id, store_id, sfdc_case_id, sfdc_case_file_id, uploaded_by, original_name, s3_bucket, s3_key, mime_type, size_bytes)
				VALUES (${docId}, ${t.store.id}, ${t.caseId}, ${t.slot.id}, ${t.userId}, ${input.fileName}, ${bucket}, ${key}, ${mime}, ${input.bytes.length})`;
		} else {
			await sql`
				INSERT INTO store_documents (id, store_id, sfdc_case_file_id, uploaded_by, original_name, s3_bucket, s3_key, mime_type, size_bytes)
				VALUES (${docId}, ${t.store.id}, ${t.slot.id}, ${t.userId}, ${input.fileName}, ${bucket}, ${key}, ${mime}, ${input.bytes.length})`;
		}
	} catch (e) {
		await deleteObject(key).catch(() => {});
		const d = describeError(e);
		await logError({ source: 'api.v1', operation: 'required_files.insert_row', userId: t.userId, accountId: t.store.account_id, errorMessage: d.errorMessage, stack: d.stack, context: errCtx });
		throw new ApiError(500, 'INTERNAL_ERROR', 'Could not record the file.');
	}

	let sf: { ok: true } | { ok: false; error: string } = { ok: true };
	const relatedRecordId = t.caseId ?? t.store.sfdc_store_id;
	if (relatedRecordId) {
		sf = await attachUploadToRequiredFile(
			{
				requiredFileId: t.slot.id, relatedRecordId, relatedObjectType: t.caseId ? 'Case' : 'Store__c', bucket, key,
				region: getRegion(), fileName: input.fileName, contentType: mime, sizeBytes: input.bytes.length
			},
			{ userId: t.userId, accountId: t.store.account_id }
		);
	}
	return {
		id: docId, requiredFileId: t.slot.id, fileName: input.fileName, contentType: mime, sizeBytes: input.bytes.length,
		salesforceSynced: sf.ok, ...(sf.ok ? {} : { salesforceError: sf.error })
	};
}
