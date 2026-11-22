/** /api/v1/stores/{storeId}/cases — GET (cases.list), POST (cases.create). */
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { apiRoute, apiJson, readJsonObject, requireUuid, optStr, parsePaging } from '$lib/server/integrations/http';
import { ApiError } from '$lib/server/integrations/errors';
import { hashRequest, readIdempotencyKey, withIdempotency } from '$lib/server/integrations/idempotency';
import { requireIntegrationStore, getUserSfdcContactId } from '$lib/server/integrations/resources';
import { caseSummaryJson } from '$lib/server/integrations/serializers';
import { listCasesForStore, createApiCase } from '$lib/server/salesforce';
import { htmlToText, sanitizeMessageHtml } from '$lib/server/sanitize';

export const GET: RequestHandler = apiRoute(
	{ permission: 'cases.list', operation: 'cases.list', resourceType: 'case' },
	async ({ event, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		audit.resourceType = 'store';
		audit.resourceId = storeId;
		const store = await requireIntegrationStore(principal.accountId, storeId);
		const { limit, offset } = parsePaging(event.url);
		if (!store.sfdc_store_id) return apiJson({ data: [], paging: { limit, offset, total: 0 } });
		const res = await listCasesForStore(store.sfdc_store_id, { accountId: principal.accountId });
		if (!res.ok) throw new ApiError(502, 'UPSTREAM_ERROR', 'Could not load cases right now.');
		return apiJson({ data: res.cases.slice(offset, offset + limit).map(caseSummaryJson), paging: { limit, offset, total: res.cases.length } });
	}
);

const PRIORITIES = ['Low', 'Medium', 'High'] as const;

export const POST: RequestHandler = apiRoute(
	{ permission: 'cases.create', operation: 'cases.create', resourceType: 'case' },
	async ({ event, request, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		const key = readIdempotencyKey(request);
		const store = await requireIntegrationStore(principal.accountId, storeId);
		const body = await readJsonObject(request);

		const subject = optStr(body, 'subject', 255);
		if (!subject) throw new ApiError(422, 'VALIDATION_ERROR', 'subject is required.');
		let description = optStr(body, 'description', 32000) ?? null;
		if (description) description = htmlToText(sanitizeMessageHtml(description)) || null;
		const priority = (optStr(body, 'priority', 10) ?? 'Medium') as (typeof PRIORITIES)[number];
		if (!PRIORITIES.includes(priority)) throw new ApiError(422, 'VALIDATION_ERROR', `priority must be one of ${PRIORITIES.join(', ')}.`);
		if (!store.sfdc_store_id) throw new ApiError(409, 'STORE_NOT_SYNCED', 'This store is not linked to Salesforce yet.');

		const result = await withIdempotency(
			principal.integrationId,
			`cases.create:${storeId}`,
			key,
			hashRequest(subject, description ?? '', priority),
			async () => {
				const [acct] = await sql<{ sfdc_account_id: string | null }[]>`SELECT sfdc_account_id FROM accounts WHERE id = ${principal.accountId}`;
				if (!acct?.sfdc_account_id) throw new ApiError(409, 'ACCOUNT_NOT_SYNCED', 'This account is not linked to Salesforce yet.');
				const created = await createApiCase(
					{ subject, description, priority, sfdcAccountId: acct.sfdc_account_id, sfdcStoreId: store.sfdc_store_id!,
					  sfdcContactId: await getUserSfdcContactId(principal.defaultUserId) },
					{ userId: principal.defaultUserId, accountId: principal.accountId }
				);
				if (!created.ok) throw new ApiError(502, 'UPSTREAM_ERROR', 'Salesforce rejected the case.');
				audit.resourceId = created.id;
				return { status: 201, body: { data: { id: created.id, storeId, subject, priority, status: 'New' } } };
			}
		);
		return apiJson(result.body, result.status, result.replayed ? { 'idempotent-replayed': 'true' } : {});
	}
);
