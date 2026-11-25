/** GET handlers for the /api/v1 required-file download endpoints (store-level and case-level slots). */
import type { RequestHandler } from '@sveltejs/kit';
import { apiRoute, requireSfId, requireUuid } from './http';
import { ApiError } from './errors';
import { requireIntegrationCase, requireIntegrationRequiredFile, requireIntegrationStore, requireIntegrationStoreRequiredFile } from './resources';
import { findSlotFile, presignSlotFile, type SlotFileKind } from '../files/required_file_download';
import { diskFileResponse } from '../files/disk_file';

export function slotDownloadRoute(scope: 'store' | 'case', kind: SlotFileKind): RequestHandler {
	return apiRoute(
		{ permission: 'files.download', operation: `${scope === 'store' ? 'store_' : ''}required_files.download_${kind}`, resourceType: 'required_file' },
		async ({ event, principal, audit }) => {
			const storeId = requireUuid(event.params.storeId, 'Store');
			const caseId = scope === 'case' ? requireSfId(event.params.caseId, 'Case') : undefined;
			const slotId = requireSfId(event.params.requiredFileId, 'Required file');
			audit.resourceId = slotId;
			audit.metadata = { storeId, ...(caseId ? { caseId } : {}) };

			const store = await requireIntegrationStore(principal.accountId, storeId);
			if (caseId) await requireIntegrationCase(store, caseId, principal.accountId);
			const slot = caseId ? await requireIntegrationRequiredFile(caseId, slotId) : await requireIntegrationStoreRequiredFile(store, slotId);

			const file = await findSlotFile({ storeId: store.id, caseId, slot }, kind);
			const disposition = event.url.searchParams.get('disposition') === 'inline' ? 'inline' : 'attachment';
			audit.metadata = { ...audit.metadata, fileName: file.fileName, storage: file.source };

			if (file.source === 'disk') {
				const response = diskFileResponse(file.storagePath, file, disposition);
				if (!response) throw new ApiError(404, 'FILE_NOT_FOUND', 'The file is missing from storage.');
				return response;
			}
			const { url } = await presignSlotFile(file, disposition, { accountId: principal.accountId, requiredFileId: slot.id });
			return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } });
		}
	);
}
