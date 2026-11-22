/** /api/v1/stores/{storeId} — GET (stores.read), PATCH (stores.update). */
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { apiRoute, apiJson, readJsonObject, requireUuid } from '$lib/server/integrations/http';
import { ApiError } from '$lib/server/integrations/errors';
import { STORE_COLUMNS, requireIntegrationStore, type ApiStore } from '$lib/server/integrations/resources';
import { storeJson } from '$lib/server/integrations/serializers';
import { updateSalesforceStore } from '$lib/server/salesforce';
import { validateStoreFields } from '$lib/server/integrations/store_fields';

export const GET: RequestHandler = apiRoute(
	{ permission: 'stores.read', operation: 'stores.read', resourceType: 'store' },
	async ({ event, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		audit.resourceId = storeId;
		const store = await requireIntegrationStore(principal.accountId, storeId);
		return apiJson({ data: storeJson(store) });
	}
);

export const PATCH: RequestHandler = apiRoute(
	{ permission: 'stores.update', operation: 'stores.update', resourceType: 'store' },
	async ({ event, request, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		audit.resourceId = storeId;
		const store = await requireIntegrationStore(principal.accountId, storeId);
		const body = await readJsonObject(request);
		const f = validateStoreFields(body, false);
		const changed = Object.entries(f).filter(([, v]) => v !== undefined);
		if (changed.length === 0) throw new ApiError(422, 'VALIDATION_ERROR', 'No updatable fields were provided.');
		audit.metadata = { fields: changed.map(([k]) => k) };

		const next = {
			name: f.name ?? store.name,
			seller_primary_email: f.sellerPrimaryEmail === undefined ? store.seller_primary_email : f.sellerPrimaryEmail,
			store_email: f.storeEmail === undefined ? store.store_email : f.storeEmail,
			business_name: f.businessName === undefined ? store.business_name : f.businessName,
			country: f.country === undefined ? store.country : f.country,
			description: f.description === undefined ? store.description : f.description
		};
		await sql`
			UPDATE stores SET name = ${next.name}, seller_primary_email = ${next.seller_primary_email}, store_email = ${next.store_email},
			       business_name = ${next.business_name}, country = ${next.country}, description = ${next.description}, updated_at = now()
			WHERE id = ${storeId} AND account_id = ${principal.accountId}`;

		let salesforceSynced: boolean | null = null;
		if (store.sfdc_store_id) {
			const r = await updateSalesforceStore(
				store.sfdc_store_id,
				{ name: next.name, sellerPrimaryEmail: next.seller_primary_email, storeEmail: next.store_email,
				  businessName: next.business_name, country: next.country, description: next.description },
				{ userId: principal.defaultUserId, accountId: principal.accountId, localStoreId: storeId }
			);
			salesforceSynced = r.ok;
		}
		const [updated] = await sql<ApiStore[]>`SELECT ${STORE_COLUMNS} FROM stores WHERE id = ${storeId}`;
		return apiJson({ data: storeJson(updated), salesforceSynced });
	}
);
