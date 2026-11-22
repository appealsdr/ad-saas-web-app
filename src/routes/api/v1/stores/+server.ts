/** /api/v1/stores — GET (stores.list), POST (stores.create). Permissions never imply one another. */
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { apiRoute, apiJson, readJsonObject, optStr, parsePaging } from '$lib/server/integrations/http';
import { ApiError } from '$lib/server/integrations/errors';
import { hashRequest, readIdempotencyKey, withIdempotency } from '$lib/server/integrations/idempotency';
import { STORE_COLUMNS, type ApiStore } from '$lib/server/integrations/resources';
import { storeJson } from '$lib/server/integrations/serializers';
import { createSalesforceStore } from '$lib/server/salesforce';
import { getDefaultStorePointOfContactId } from '$lib/server/account/contacts';
import { logError, describeError } from '$lib/server/error_log';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const GET: RequestHandler = apiRoute(
	{ permission: 'stores.list', operation: 'stores.list', resourceType: 'store' },
	async ({ event, principal }) => {
		const { limit, offset } = parsePaging(event.url);
		const rows = await sql<ApiStore[]>`
			SELECT ${STORE_COLUMNS} FROM stores
			WHERE account_id = ${principal.accountId}
			ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}
		`;
		return apiJson({ data: rows.map(storeJson), paging: { limit, offset } });
	}
);

export function validateStoreFields(body: Record<string, unknown>, requireName: boolean) {
	const name = optStr(body, 'name', 200);
	if (requireName && !name) throw new ApiError(422, 'VALIDATION_ERROR', 'name is required.');
	if (name === null) throw new ApiError(422, 'VALIDATION_ERROR', 'name cannot be empty.');
	const sellerPrimaryEmail = optStr(body, 'sellerPrimaryEmail', 254);
	const storeEmail = optStr(body, 'storeEmail', 254);
	for (const [k, v] of [['sellerPrimaryEmail', sellerPrimaryEmail], ['storeEmail', storeEmail]] as const) {
		if (v && !EMAIL_RE.test(v)) throw new ApiError(422, 'VALIDATION_ERROR', `${k} is not a valid email address.`);
	}
	return {
		name,
		sellerPrimaryEmail,
		storeEmail,
		businessName: optStr(body, 'businessName', 200),
		country: optStr(body, 'country', 100),
		description: optStr(body, 'description', 2000)
	};
}

export const POST: RequestHandler = apiRoute(
	{ permission: 'stores.create', operation: 'stores.create', resourceType: 'store' },
	async ({ request, principal, audit }) => {
		const key = readIdempotencyKey(request);
		const body = await readJsonObject(request);
		const f = validateStoreFields(body, true);

		const result = await withIdempotency(principal.integrationId, 'stores.create', key, hashRequest(JSON.stringify(f)), async () => {
			const [acct] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${principal.accountId}`;
			let storeId: string;
			try {
				const [row] = await sql<{ id: string }[]>`
					INSERT INTO stores (account_id, created_by, name, seller_primary_email, store_email, business_name, country, description)
					VALUES (${principal.accountId}, ${principal.defaultUserId}, ${f.name!}, ${f.sellerPrimaryEmail ?? null},
					        ${f.storeEmail ?? null}, ${f.businessName ?? null}, ${f.country ?? null}, ${f.description ?? null})
					RETURNING id`;
				storeId = row.id;
			} catch (e) {
				const d = describeError(e);
				await logError({ source: 'api.v1.stores', operation: 'insert_local', accountId: principal.accountId, errorMessage: d.errorMessage, stack: d.stack });
				throw new ApiError(500, 'INTERNAL_ERROR', 'Could not create the store.');
			}
			const poc = await getDefaultStorePointOfContactId(principal.accountId);
			if (poc) await sql`UPDATE stores SET point_of_contact_id = ${poc} WHERE id = ${storeId}`;

			const sf = await createSalesforceStore(
				{ name: f.name!, sfdcAccountId: acct?.sfdc_account_id ?? null, sellerPrimaryEmail: f.sellerPrimaryEmail ?? null, storeEmail: f.storeEmail ?? null,
				  businessName: f.businessName ?? null, country: f.country ?? null, description: f.description ?? null },
				{ userId: principal.defaultUserId, accountId: principal.accountId, localStoreId: storeId }
			);
			// Same best-effort Salesforce sync as the app: a failed push is logged and retried by the app's sync flow.
			if (sf.ok) await sql`UPDATE stores SET sfdc_store_id = ${sf.sfdcStoreId} WHERE id = ${storeId}`.catch(() => {});
			const [store] = await sql<ApiStore[]>`SELECT ${STORE_COLUMNS} FROM stores WHERE id = ${storeId}`;
			audit.resourceId = storeId;
			return { status: 201, body: { data: storeJson(store), salesforceSynced: sf.ok } };
		});
		return apiJson(result.body, result.status, result.replayed ? { 'idempotent-replayed': 'true' } : {});
	}
);
