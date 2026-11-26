/** /api/v1/stores/{storeId}/cases/{caseId}/messages — GET (messages.list), POST (messages.create). */
import type { RequestHandler } from './$types';
import { apiRoute, apiJson, readJsonObject, requireUuid, requireSfId, optStr } from '$lib/server/integrations/http';
import { ApiError } from '$lib/server/integrations/errors';
import { hashRequest, readIdempotencyKey, withIdempotency } from '$lib/server/integrations/idempotency';
import { requireIntegrationStore, requireIntegrationCase, getUserSfdcContactId } from '$lib/server/integrations/resources';
import { messageJson } from '$lib/server/integrations/serializers';
import { listCaseMessages, createCaseMessage } from '$lib/server/salesforce';
import { sanitizeMessageHtml, htmlToText } from '$lib/server/sanitize';
import { advanceCaseWhenClientDone } from '$lib/server/salesforce/case-auto-status';

export const GET: RequestHandler = apiRoute(
	{ permission: 'messages.list', operation: 'messages.list', resourceType: 'case' },
	async ({ event, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		const caseId = requireSfId(event.params.caseId, 'Case');
		audit.resourceId = caseId;
		const store = await requireIntegrationStore(principal.accountId, storeId);
		await requireIntegrationCase(store, caseId, principal.accountId);
		const res = await listCaseMessages(caseId, { accountId: principal.accountId });
		if (!res.ok) throw new ApiError(502, 'UPSTREAM_ERROR', 'Could not load messages right now.');
		return apiJson({ data: res.messages.map(messageJson) });
	}
);

export const POST: RequestHandler = apiRoute(
	{ permission: 'messages.create', operation: 'messages.create', resourceType: 'case' },
	async ({ event, request, principal, audit }) => {
		const storeId = requireUuid(event.params.storeId, 'Store');
		const caseId = requireSfId(event.params.caseId, 'Case');
		audit.resourceId = caseId;
		const key = readIdempotencyKey(request);
		const store = await requireIntegrationStore(principal.accountId, storeId);
		await requireIntegrationCase(store, caseId, principal.accountId);

		const body = await readJsonObject(request);
		const raw = optStr(body, 'body', 32000);
		if (!raw) throw new ApiError(422, 'VALIDATION_ERROR', 'body is required.');
		const clean = sanitizeMessageHtml(raw); // same sanitisation as the app before storing
		if (!htmlToText(clean)) throw new ApiError(422, 'VALIDATION_ERROR', 'body cannot be empty.');
		const replyTo = optStr(body, 'replyToMessageId', 18) ?? null;
		if (replyTo) requireSfId(replyTo, 'Reply-to message');

		const contactId = await getUserSfdcContactId(principal.defaultUserId);
		if (!contactId) throw new ApiError(409, 'USER_NOT_SYNCED', "The integration's default user is not linked to a Salesforce Contact yet.");

		const result = await withIdempotency(principal.integrationId, `messages.create:${caseId}`, key, hashRequest(clean, replyTo ?? ''), async () => {
			const created = await createCaseMessage(
				{ caseId, senderContactId: contactId, body: clean, replyToMessageId: replyTo },
				{ userId: principal.defaultUserId, accountId: principal.accountId }
			);
			if (!created.ok) throw new ApiError(502, 'UPSTREAM_ERROR', 'Salesforce rejected the message.');
			await advanceCaseWhenClientDone(caseId, { userId: principal.defaultUserId, accountId: principal.accountId });
			return { status: 201, body: { data: { id: created.id, caseId } } };
		});
		return apiJson(result.body, result.status, result.replayed ? { 'idempotent-replayed': 'true' } : {});
	}
);
