/**
 * Issue (Case) detail.
 *
 * Loaded in parallel:
 *   - Local store (tenancy + SF Store Id)
 *   - SF Case (read-only)
 *   - SF Case_Message__c rows (comments)
 *   - SF Case_File__c rows (required-file checklist) joined with local
 *     case_documents on sfdc_case_file_id → upload metadata
 *
 * Actions:
 *   post_comment  — INSERT Case_Message__c (Sender_Contact__c, Message_Body__c,
 *                                           Sender_Type__c='external')
 *   upload_doc    — for ONE required file slot: PUT to S3 → UPSERT local row
 *                   → PATCH Case_File__c.Client_File_Info__c = s3://<bucket>/<key>
 *                   Re-upload UPSERTs the same row + deletes the old S3 object.
 *   clear_doc     — reverse: DELETE S3 + local row + clear SF Client_File_Info__c
 */
import { fail, redirect, error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { sql } from '$lib/server/db';
import {
	fetchCase,
	listCaseMessages,
	createCaseMessage,
	markCaseMessageRead,
	listRequiredFilesForCase,
	attachUploadToRequiredFile,
	clearRequiredFile,
	listCaseHistory,
	buildCaseTimeline,
	fetchStoreMetrics,
	updateCaseEstimatedRevenueAtRisk
} from '$lib/server/salesforce';
import { putObject, deleteObject, getRegion } from '$lib/server/storage/s3';
import { caseFileKey } from '$lib/server/storage/s3-paths';
import { sanitizeMessageHtml, htmlToText } from '$lib/server/sanitize';
import { logError, describeError } from '$lib/server/error_log';
import { getStoreAccessToken } from '$lib/server/spapi';
import { getAsinAverageDailyRevenue } from '$lib/server/spapi_reports';

/**
 * Fixed days-at-risk assumption per case type/record type, used to turn an
 * ASIN's average daily revenue into an estimated revenue-at-risk figure:
 *   revenue at risk = average daily revenue × days at risk
 * Matched by substring against Case.Type / RecordType.Name (case-insensitive).
 * These are placeholder business assumptions — adjust to match real figures.
 */
const DAYS_AT_RISK_RULES: { match: string; days: number }[] = [
	{ match: 'suspension', days: 30 },
	{ match: 'deactivation', days: 30 },
	{ match: 'high impact', days: 14 },
	{ match: 'high repeat', days: 14 },
	{ match: 'medium impact', days: 10 },
	{ match: 'medium repeat', days: 10 },
	{ match: 'low impact', days: 5 },
	{ match: 'low repeat', days: 5 },
	{ match: 'a-z claim', days: 7 },
	{ match: 'chargeback', days: 7 }
];
const DEFAULT_DAYS_AT_RISK = 7;

function daysAtRiskFor(caseType: string | null, recordTypeName: string | null): number {
	const haystack = `${caseType ?? ''} ${recordTypeName ?? ''}`.toLowerCase();
	for (const rule of DAYS_AT_RISK_RULES) {
		if (haystack.includes(rule.match)) return rule.days;
	}
	return DEFAULT_DAYS_AT_RISK;
}

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME = new Set([
	'application/pdf',
	'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/heic',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'text/plain', 'text/csv',
	'application/zip'
]);

function safeFilename(name: string): string {
	const base = basename(name).replace(/[^\w.\-]/g, '_').slice(-120);
	return base || 'upload';
}

interface StoreRow {
	id: string;
	account_id: string;
	name: string;
	marketplaces: string | null;
	sfdc_store_id: string | null;
}

async function loadStore(storeId: string, userId: string): Promise<StoreRow | null> {
	const rows = await sql<StoreRow[]>`
		SELECT s.id, s.account_id, s.name, s.marketplaces, s.sfdc_store_id
		FROM stores s JOIN users u ON u.id = ${userId}
		WHERE s.id = ${storeId} AND s.account_id = u.account_id
		LIMIT 1
	`;
	return rows[0] ?? null;
}

interface LocalUploadRow {
	id: string;
	sfdc_case_file_id: string;
	original_name: string;
	mime_type: string | null;
	size_bytes: bigint;
	s3_bucket: string;
	s3_key: string;
	created_at: Date;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const store = await loadStore(params.id, locals.user.id);
	if (!store) throw error(404, 'Store not found.');

	const ctx = { userId: locals.user.id, accountId: store.account_id };
	const [caseResult, messagesResult, filesResult, historyResult, uploads, storeMetrics] = await Promise.all([
		fetchCase(params.caseId, ctx),
		listCaseMessages(params.caseId, ctx),
		listRequiredFilesForCase(params.caseId),
		listCaseHistory(params.caseId, ctx),
		sql<LocalUploadRow[]>`
			SELECT id, sfdc_case_file_id, original_name, mime_type, size_bytes,
			       s3_bucket, s3_key, created_at
			FROM case_documents
			WHERE sfdc_case_id = ${params.caseId}
			  AND store_id = ${store.id}
			  AND sfdc_case_file_id IS NOT NULL
		`,
		store.sfdc_store_id
			? fetchStoreMetrics(store.sfdc_store_id, ctx)
			: Promise.resolve({
					totalRevenueRecovered: null,
					totalClosedCases: null,
					totalOpenCases: null,
					totalCases: null,
					storeHealth: null
				})
	]);

	if (!caseResult.ok) {
		if (caseResult.notFound) throw error(404, 'Case not found in Salesforce.');
		throw error(502, `Could not load case: ${caseResult.error}`);
	}

	// Join Required_File__c rows with local upload metadata by the required-file
	// id (stored in the legacy sfdc_case_file_id column of the mirror table).
	const localByReqId = new Map<string, LocalUploadRow>();
	for (const u of uploads) localByReqId.set(u.sfdc_case_file_id, u);

	const requiredFiles = (filesResult.ok ? filesResult.files : []).map((f) => {
		const local = localByReqId.get(f.id) ?? null;
		const uploaded = f.uploaded || !!local;
		return {
			id: f.id,
			name: f.name,
			shortDescription: f.shortDescription,
			instructions: f.instructions,
			acceptedFormats: f.acceptedFormats,
			createdAt: f.createdAt,
			uploaded,
			upload: uploaded
				? {
						localDocId: local?.id ?? null,
						s3DocumentId: f.upload?.s3DocumentId ?? null,
						fileName: local?.original_name ?? f.upload?.fileName ?? 'file',
						fileExtension: f.upload?.fileExtension ?? null,
						contentType: local?.mime_type ?? f.upload?.contentType ?? null,
						sizeBytes: local ? Number(local.size_bytes) : null,
						createdAt: local?.created_at.toISOString() ?? f.upload?.uploadedDate ?? null
					}
				: null,
			example: f.example
				? {
						s3DocumentId: f.example.s3DocumentId,
						fileName: f.example.fileName,
						contentType: f.example.contentType,
						fileExtension: f.example.fileExtension
					}
				: null
		};
	});

	// Sanitize message HTML once — the page renders bodies with {@html}, so
	// every message (new or SF-authored) must be cleaned before it reaches the
	// browser. The timeline gets a plain-text variant (it renders text, not HTML).
	const messages = (messagesResult.ok ? messagesResult.messages : []).map((m) => ({
		...m,
		body: sanitizeMessageHtml(m.body)
	}));

	const timeline = buildCaseTimeline({
		caseRecord: caseResult.record,
		messages: messages.map((m) => ({ ...m, body: htmlToText(m.body) })),
		requiredFiles: requiredFiles.map((f) => ({
			caseFileId: f.id,
			name: f.name,
			createdAt: f.createdAt,
			upload: f.upload?.localDocId
				? {
						id: f.upload.localDocId,
						originalName: f.upload.fileName,
						createdAt: f.upload.createdAt ?? f.createdAt
					}
				: null
		})),
		history: historyResult.ok ? historyResult.history : []
	});

	return {
		storeId: store.id,
		storeName: store.name,
		storeMarketplaces: store.marketplaces,
		storeTotalSaved: storeMetrics.totalRevenueRecovered,
		case: caseResult.record,
		messages,
		messagesError: messagesResult.ok ? null : messagesResult.error,
		requiredFiles,
		filesError: filesResult.ok ? null : filesResult.error,
		timeline,
		historyError: historyResult.ok ? null : historyResult.error,
		currentUser: {
			id: locals.user.id,
			displayName: locals.user.displayName,
			sfdcContactId: locals.user.sfdcContactId ?? null
		}
	};
};

export const actions: Actions = {
	post_comment: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		const data = await request.formData();
		const rawBody = String(data.get('body') ?? '');
		const body = sanitizeMessageHtml(rawBody); // strip unsafe HTML before storing
		const text = htmlToText(body); // plain text for the empty check
		const replyToMessageId = String(data.get('replyToMessageId') ?? '').trim() || null;
		if (!text) return fail(400, { commentBody: rawBody, commentError: 'Comment cannot be empty.' });
		if (body.length > 32000)
			return fail(400, { commentBody: rawBody, commentError: 'Comment is too long.' });

		const [row] = await sql<{ sfdc_contact_id: string | null }[]>`
			SELECT sfdc_contact_id FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!row?.sfdc_contact_id) {
			return fail(409, {
				commentBody: body,
				commentError: 'Your Salesforce Contact is not linked yet. Try again once sync completes.'
			});
		}

		const result = await createCaseMessage(
			{ caseId: params.caseId, senderContactId: row.sfdc_contact_id, body, replyToMessageId },
			{ userId: locals.user.id, accountId: store.account_id }
		);
		if (!result.ok) {
			return fail(502, { commentBody: body, commentError: `Salesforce rejected the comment: ${result.error}` });
		}
		return { commentSuccess: 'Comment posted.' };
	},

	/** Mark a single Case_Message__c as read (Message_Read__c = now). */
	mark_read: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		const data = await request.formData();
		const messageId = String(data.get('messageId') ?? '').trim();
		if (!messageId) return fail(400, { readError: 'Missing message id.' });

		const result = await markCaseMessageRead(messageId, {
			userId: locals.user.id,
			accountId: store.account_id
		});
		if (!result.ok) return fail(502, { readError: result.error });
		return { readSuccess: true, readMessageId: messageId };
	},

	/**
	 * Pull the case's ASIN sales data from Amazon (SP-API Sales and Traffic
	 * Report), apply the fixed days-at-risk assumption for this case's type,
	 * and write the result to Case.Estimated_Revenue_at_Risk__c.
	 */
	recalculate_revenue_at_risk: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		const ctx = { userId: locals.user.id, accountId: store.account_id, storeId: store.id };

		const caseResult = await fetchCase(params.caseId, ctx);
		if (!caseResult.ok) {
			return fail(502, { revenueRiskError: `Could not load case: ${caseResult.error}` });
		}
		const { asin, Type, recordTypeName } = caseResult.record;
		if (!asin) {
			return fail(409, { revenueRiskError: 'This case has no ASIN set — nothing to look up on Amazon.' });
		}

		const accessToken = await getStoreAccessToken(store.id);
		if (!accessToken) {
			return fail(409, { revenueRiskError: 'This store is not connected to Amazon via SP-API.' });
		}

		const revenueResult = await getAsinAverageDailyRevenue(accessToken, store.marketplaces, asin, 30, ctx);
		if (!revenueResult.ok) {
			return fail(502, { revenueRiskError: `Could not fetch Amazon sales data: ${revenueResult.error}` });
		}

		const days = daysAtRiskFor(Type, recordTypeName);
		const estimate = Math.round(revenueResult.averageDailyRevenue * days);

		const updateResult = await updateCaseEstimatedRevenueAtRisk(params.caseId, estimate, ctx);
		if (!updateResult.ok) {
			return fail(502, {
				revenueRiskError: `Computed $${estimate.toLocaleString()} but Salesforce rejected the update: ${updateResult.error}`
			});
		}

		return {
			revenueRiskSuccess: `Estimated revenue at risk recalculated: $${estimate.toLocaleString()} (avg $${Math.round(revenueResult.averageDailyRevenue).toLocaleString()}/day × ${days} days).`
		};
	},

	/**
	 * Upload OR re-upload for a single Required_File__c slot.
	 * Body: multipart with { file, requiredFileId }.
	 */
	upload_doc: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		const data = await request.formData();
		const file = data.get('file');
		const requiredFileId = String(data.get('requiredFileId') ?? '').trim();

		if (!requiredFileId) return fail(400, { uploadError: 'Missing required file.' });
		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { uploadError: 'Pick a file to upload.' });
		}
		if (file.size > MAX_UPLOAD_BYTES) {
			return fail(400, { uploadError: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` });
		}
		if (file.type && !ALLOWED_MIME.has(file.type)) {
			return fail(400, { uploadError: `Unsupported file type: ${file.type}` });
		}

		// 1. Push new bytes to S3. Old key (if any) is deleted at the end so a
		//    failure mid-upload leaves the prior successful upload intact.
		const newDocId = randomUUID();
		const cleanName = safeFilename(file.name);
		const s3Key = caseFileKey({
			accountId: store.account_id,
			storeId: store.id,
			sfdcCaseId: params.caseId,
			docId: newDocId,
			filename: cleanName
		});
		const buffer = Buffer.from(await file.arrayBuffer());

		let bucket: string;
		try {
			const result = await putObject(s3Key, buffer, file.type || undefined);
			bucket = result.bucket;
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'cases.upload_doc',
				operation: 's3_put',
				userId: locals.user.id,
				accountId: store.account_id,
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { caseId: params.caseId, requiredFileId, s3Key }
			});
			return fail(502, { uploadError: 'Could not upload to S3. Check AWS credentials and bucket access.' });
		}

		// 2. UPSERT local mirror row by the required-file id (sfdc_case_file_id
		//    column). Capture any prior s3_key for cleanup.
		let oldS3Key: string | null = null;
		try {
			const prior = await sql<{ s3_key: string | null }[]>`
				SELECT s3_key FROM case_documents
				WHERE sfdc_case_file_id = ${requiredFileId} LIMIT 1
			`;
			oldS3Key = prior[0]?.s3_key ?? null;

			await sql`
				INSERT INTO case_documents (
					id, store_id, sfdc_case_id, sfdc_case_file_id, uploaded_by,
					original_name, s3_bucket, s3_key, mime_type, size_bytes
				)
				VALUES (
					${newDocId}, ${store.id}, ${params.caseId}, ${requiredFileId}, ${locals.user.id},
					${file.name}, ${bucket}, ${s3Key}, ${file.type || null}, ${file.size}
				)
				ON CONFLICT (sfdc_case_file_id) WHERE sfdc_case_file_id IS NOT NULL
				DO UPDATE SET
					id = EXCLUDED.id,
					uploaded_by = EXCLUDED.uploaded_by,
					original_name = EXCLUDED.original_name,
					s3_bucket = EXCLUDED.s3_bucket,
					s3_key = EXCLUDED.s3_key,
					mime_type = EXCLUDED.mime_type,
					size_bytes = EXCLUDED.size_bytes,
					created_at = now()
			`;
		} catch (e) {
			await deleteObject(s3Key); // roll back the new S3 write
			const desc = describeError(e);
			await logError({
				source: 'cases.upload_doc',
				operation: 'upsert_row',
				userId: locals.user.id,
				accountId: store.account_id,
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { caseId: params.caseId, requiredFileId, s3Key }
			});
			return fail(500, { uploadError: 'Uploaded the file but could not index it.' });
		}

		// 3. Create S3_Document__c (Related_Record_Id__c = Case Id) and point the
		//    Required_File__c at it (Last_Version__c + File_Uploaded__c = true).
		const sfResult = await attachUploadToRequiredFile(
			{
				requiredFileId,
				relatedRecordId: params.caseId,
				relatedObjectType: 'Case',
				bucket,
				key: s3Key,
				region: getRegion(),
				fileName: file.name,
				contentType: file.type || null,
				sizeBytes: file.size
			},
			{ userId: locals.user.id, accountId: store.account_id }
		);

		// 4. Best-effort cleanup of any prior S3 object for this slot.
		if (oldS3Key && oldS3Key !== s3Key) await deleteObject(oldS3Key);

		if (!sfResult.ok) {
			return {
				uploadSuccess: `Uploaded ${file.name}, but Salesforce sync had an issue: ${sfResult.error}.`
			};
		}
		return { uploadSuccess: `Uploaded ${file.name}.` };
	},

	/**
	 * Clear the upload for one Required_File__c slot: drop S3 object + local row,
	 * unset Last_Version__c / File_Uploaded__c, tombstone the old S3_Document__c.
	 * Body: { requiredFileId, s3DocumentId }.
	 */
	clear_doc: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		const data = await request.formData();
		const requiredFileId = String(data.get('requiredFileId') ?? '').trim();
		const s3DocumentId = String(data.get('s3DocumentId') ?? '').trim() || null;
		if (!requiredFileId) return fail(400, { uploadError: 'Missing required file.' });

		const rows = await sql<{ s3_key: string }[]>`
			DELETE FROM case_documents
			WHERE sfdc_case_file_id = ${requiredFileId}
			  AND store_id = ${store.id}
			RETURNING s3_key
		`;
		if (rows[0]?.s3_key) await deleteObject(rows[0].s3_key);

		await clearRequiredFile(requiredFileId, s3DocumentId, {
			userId: locals.user.id,
			accountId: store.account_id
		});
		return { uploadSuccess: 'Upload cleared. Slot is pending again.' };
	}
};
