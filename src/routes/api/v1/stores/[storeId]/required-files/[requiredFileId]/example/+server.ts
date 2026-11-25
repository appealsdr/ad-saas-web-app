/** GET /api/v1/stores/{storeId}/required-files/{requiredFileId}/example — files.download. */
import { slotDownloadRoute } from '$lib/server/integrations/download_http';

export const GET = slotDownloadRoute('store', 'example');
