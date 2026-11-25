/** GET /api/v1/stores/{storeId}/required-files/{requiredFileId}/file — files.download. */
import { slotDownloadRoute } from '$lib/server/integrations/download_http';

export const GET = slotDownloadRoute('store', 'upload');
