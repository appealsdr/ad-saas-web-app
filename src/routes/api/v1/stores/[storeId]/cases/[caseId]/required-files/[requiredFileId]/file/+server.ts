/** GET /api/v1/stores/{storeId}/cases/{caseId}/required-files/{requiredFileId}/file — files.download. */
import { slotDownloadRoute } from '$lib/server/integrations/download_http';

export const GET = slotDownloadRoute('case', 'upload');
