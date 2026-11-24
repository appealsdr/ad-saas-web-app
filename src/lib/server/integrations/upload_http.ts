/** Shared request handling for the raw-body upload endpoints (case-level and store-level required files). */
import { ApiError } from './errors';
import { apiJson, type ApiContext } from './http';
import { hashRequest, readIdempotencyKey, withIdempotency } from './idempotency';
import { MAX_UPLOAD_BYTES, storeRequiredFileUpload } from '../files/required_file_upload';
import type { ApiStore } from './resources';
import type { RequiredFile } from '../salesforce';

function decodeFileName(raw: string | null): string {
	if (!raw) throw new ApiError(422, 'VALIDATION_ERROR', 'X-File-Name is required.');
	try {
		return decodeURIComponent(raw).trim();
	} catch {
		return raw.trim();
	}
}

/** The file is the raw request body (not multipart). Headers: Content-Type, X-File-Name, [X-Replace-Existing], [Idempotency-Key]. */
export async function handleRequiredFileUpload(
	{ request, principal }: ApiContext,
	t: { store: ApiStore; caseId?: string; slot: RequiredFile }
): Promise<Response> {
	const key = readIdempotencyKey(request);
	const contentType = (request.headers.get('content-type') ?? '').split(';')[0].trim();
	const fileName = decodeFileName(request.headers.get('x-file-name'));
	const replaceExisting = (request.headers.get('x-replace-existing') ?? '').toLowerCase() === 'true';

	const declared = Number(request.headers.get('content-length') ?? 0);
	if (declared > MAX_UPLOAD_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
	const bytes = new Uint8Array(await request.arrayBuffer());
	if (bytes.length > MAX_UPLOAD_BYTES) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);

	const scope = t.caseId ? `case:${t.caseId}` : `store:${t.store.id}`;
	const result = await withIdempotency(
		principal.integrationId,
		`files.upload:${scope}:${t.slot.id}`,
		key,
		hashRequest(fileName, contentType, bytes),
		async () => {
			const r = await storeRequiredFileUpload(
				{ store: t.store, caseId: t.caseId, userId: principal.defaultUserId, slot: t.slot },
				{ contentType, fileName, bytes, replaceExisting }
			);
			const { salesforceSynced, salesforceError, ...data } = r;
			return { status: 201, body: { data, salesforceSynced, ...(salesforceError ? { salesforceError } : {}) } };
		}
	);
	return apiJson(result.body, result.status, result.replayed ? { 'idempotent-replayed': 'true' } : {});
}
