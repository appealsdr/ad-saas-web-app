/** GET /api/v1/stores/{storeId}/cases/{caseId} — cases.read. */
import type { RequestHandler } from './$types';
import { apiRoute, apiJson, requireUuid, requireSfId } from '$lib/server/integrations/http';
import { ApiError } from '$lib/server/integrations/errors';
import { requireIntegrationStore, requireIntegrationCase } from '$lib/server/integrations/resources';
import { caseDetailJson } from '$lib/server/integrations/serializers';
import { fetchCase } from '$lib/server/salesforce';

export const GET: RequestHandler = apiRoute(
	{ permission: 'cases.read', operation: 'cases.read', resourceType: 'case' },
	async ({ event, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		const caseId = requireSfId(event.params.caseId, 'Case');
		audit.resourceId = caseId;
		const store = await requireIntegrationStore(principal.accountId, storeId);
		await requireIntegrationCase(store, caseId, principal.accountId);
		const res = await fetchCase(caseId, { accountId: principal.accountId });
		if (!res.ok) throw res.notFound ? new ApiError(404, 'NOT_FOUND', 'Case not found.') : new ApiError(502, 'UPSTREAM_ERROR', 'Could not load the case right now.');
		return apiJson({ data: caseDetailJson(res.record) });
	}
);
