/** GET /api/v1/stores/{storeId}/required-files — files.requirements.read (store-level slots, e.g. onboarding documents). */
import type { RequestHandler } from './$types';
import { apiRoute, apiJson, requireUuid } from '$lib/server/integrations/http';
import { ApiError } from '$lib/server/integrations/errors';
import { requireIntegrationStore } from '$lib/server/integrations/resources';
import { requiredFileJson } from '$lib/server/integrations/serializers';
import { listRequiredFilesForStore } from '$lib/server/salesforce';

export const GET: RequestHandler = apiRoute(
	{ permission: 'files.requirements.read', operation: 'store_required_files.list', resourceType: 'store' },
	async ({ event, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		audit.resourceId = storeId;
		const store = await requireIntegrationStore(principal.accountId, storeId);
		if (!store.sfdc_store_id) return apiJson({ data: [] });
		const res = await listRequiredFilesForStore(store.sfdc_store_id);
		if (!res.ok) throw new ApiError(502, 'UPSTREAM_ERROR', 'Could not load required files right now.');
		return apiJson({ data: res.files.map(requiredFileJson) });
	}
);
