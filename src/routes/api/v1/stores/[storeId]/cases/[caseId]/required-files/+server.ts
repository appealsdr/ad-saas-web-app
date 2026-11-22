/** GET /api/v1/stores/{storeId}/cases/{caseId}/required-files — files.requirements.read. */
import type { RequestHandler } from './$types';
import { apiRoute, apiJson, requireUuid, requireSfId } from '$lib/server/integrations/http';
import { ApiError } from '$lib/server/integrations/errors';
import { requireIntegrationStore, requireIntegrationCase } from '$lib/server/integrations/resources';
import { requiredFileJson } from '$lib/server/integrations/serializers';
import { listRequiredFilesForCase } from '$lib/server/salesforce';

export const GET: RequestHandler = apiRoute(
	{ permission: 'files.requirements.read', operation: 'required_files.list', resourceType: 'case' },
	async ({ event, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		const caseId = requireSfId(event.params.caseId, 'Case');
		audit.resourceId = caseId;
		const store = await requireIntegrationStore(principal.accountId, storeId);
		await requireIntegrationCase(store, caseId, principal.accountId);
		const res = await listRequiredFilesForCase(caseId);
		if (!res.ok) throw new ApiError(502, 'UPSTREAM_ERROR', 'Could not load required files right now.');
		return apiJson({ data: res.files.map(requiredFileJson) });
	}
);
