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
 *   upload_doc    — for ONE required file slot, one or many files: each is PUT to
 *                   S3 → INSERTed as a local row → registered as an S3_Document__c
 *                   (the newest becomes Required_File__c.Last_Version__c).
 *   clear_doc     — remove one file (docId) or, without docId, every file in the
 *                   slot. When the slot ends up empty, Required_File__c is reset.
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
const MAX_FILES_PER_UPLOAD = 10;

/** Prefix an upload error with the files that already went through in this batch. */
function uploadedSummary(done: string[], message: string): string {
	return done.length ? `${done.length} file(s) uploaded (${done.join(', ')}). ${message}` : message;
}
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
	const localByReqId = new Map<string, LocalUploadRow[]>();
	for (const u of uploads) {
		const list = localByReqId.get(u.sfdc_case_file_id) ?? [];
		list.push(u);
		localByReqId.set(u.sfdc_case_file_id, list);
	}

	const requiredFiles = (filesResult.ok ? filesResult.files : []).map((f) => {
		const localList = (localByReqId.get(f.id) ?? []).sort(
			(a, b) => b.created_at.getTime() - a.created_at.getTime()
		);
		const local = localList[0] ?? null;
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
			uploads: localList.map((u) => ({
				localDocId: u.id,
				s3DocumentId: null as string | null,
				fileName: u.original_name,
				fileExtension: null as string | null,
				contentType: u.mime_type,
				sizeBytes: Number(u.size_bytes),
				createdAt: u.created_at.toISOString()
			})),
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
		const files = data.getAll('file').filter((f): f is File => f instanceof File && f.size > 0);
		const requiredFileId = String(data.get('requiredFileId') ?? '').trim();
		// "New version" — the file this upload replaces; removed once the new one is stored.
		const replaceDocId = String(data.get('replaceDocId') ?? '').trim() || null;

		if (!requiredFileId) return fail(400, { uploadError: 'Missing required file.' });
		if (files.length === 0) return fail(400, { uploadError: 'Pick a file to upload.' });
		if (files.length > MAX_FILES_PER_UPLOAD) {
			return fail(400, { uploadError: `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.` });
		}
		// Validate everything up front so a bad file doesn't leave a partial batch.
		for (const file of files) {
			if (file.size > MAX_UPLOAD_BYTES) {
				return fail(400, {
					uploadError: `${file.name} is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).`
				});
			}
			if (file.type && !ALLOWED_MIME.has(file.type)) {
				return fail(400, { uploadError: `Unsupported file type for ${file.name}: ${file.type}` });
			}
		}

		const uploaded: string[] = [];
		const sfIssues: string[] = [];

		for (const file of files) {
			// 1. Push the bytes to S3.
			const newDocId = randomUUID();
			const s3Key = caseFileKey({
				accountId: store.account_id,
				storeId: store.id,
				sfdcCaseId: params.caseId,
				docId: newDocId,
				filename: safeFilename(file.name)
			});
			const buffer = Buffer.from(await file.arrayBuffer());

			let bucket: string;
			try {
				bucket = (await putObject(s3Key, buffer, file.type || undefined)).bucket;
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
				return fail(502, {
					uploadError: uploadedSummary(uploaded, 'Could not upload to S3. Check AWS credentials and bucket access.')
				});
			}

			// 2. Local mirror row — one per file, several per slot.
			try {
				await sql`
					INSERT INTO case_documents (
						id, store_id, sfdc_case_id, sfdc_case_file_id, uploaded_by,
						original_name, s3_bucket, s3_key, mime_type, size_bytes
					)
					VALUES (
						${newDocId}, ${store.id}, ${params.caseId}, ${requiredFileId}, ${locals.user.id},
						${file.name}, ${bucket}, ${s3Key}, ${file.type || null}, ${file.size}
					)
				`;
			} catch (e) {
				await deleteObject(s3Key); // roll back this file's S3 write
				const desc = describeError(e);
				await logError({
					source: 'cases.upload_doc',
					operation: 'insert_row',
					userId: locals.user.id,
					accountId: store.account_id,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: { caseId: params.caseId, requiredFileId, s3Key }
				});
				return fail(500, {
					uploadError: uploadedSummary(uploaded, `Uploaded ${file.name} but could not index it.`)
				});
			}

			// 3. Register S3_Document__c (Related_Record_Id__c = Case Id); the newest
			//    file in the batch ends up as Required_File__c.Last_Version__c.
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
			uploaded.push(file.name);
			if (!sfResult.ok) sfIssues.push(`${file.name}: ${sfResult.error}`);
		}

		if (replaceDocId) {
			const old = await sql<{ s3_key: string }[]>`
				DELETE FROM case_documents
				WHERE id = ${replaceDocId}
				  AND sfdc_case_file_id = ${requiredFileId}
				  AND store_id = ${store.id}
				RETURNING s3_key
			`;
			if (old[0]?.s3_key) await deleteObject(old[0].s3_key);
		}

		const label = uploaded.length === 1 ? uploaded[0] : `${uploaded.length} files`;
		if (sfIssues.length) {
			return {
				uploadSuccess: `Uploaded ${label}, but Salesforce sync had an issue: ${sfIssues.join('; ')}.`
			};
		}
		return { uploadSuccess: `Uploaded ${label}.` };
	},

	/**
	 * Remove uploads from one Required_File__c slot. With `docId`, only that file
	 * goes; without it, every file in the slot. Once the slot has no files left,
	 * Last_Version__c / File_Uploaded__c are reset and the S3_Document__c tombstoned.
	 * Body: { requiredFileId, s3DocumentId, docId? }.
	 */
	clear_doc: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		const data = await request.formData();
		const requiredFileId = String(data.get('requiredFileId') ?? '').trim();
		const s3DocumentId = String(data.get('s3DocumentId') ?? '').trim() || null;
		const docId = String(data.get('docId') ?? '').trim() || null;
		if (!requiredFileId) return fail(400, { uploadError: 'Missing required file.' });

		const rows = docId
			? await sql<{ s3_key: string }[]>`
					DELETE FROM case_documents
					WHERE id = ${docId}
					  AND sfdc_case_file_id = ${requiredFileId}
					  AND store_id = ${store.id}
					RETURNING s3_key
				`
			: await sql<{ s3_key: string }[]>`
					DELETE FROM case_documents
					WHERE sfdc_case_file_id = ${requiredFileId}
					  AND store_id = ${store.id}
					RETURNING s3_key
				`;
		for (const r of rows) if (r.s3_key) await deleteObject(r.s3_key);

		const [{ count }] = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM case_documents
			WHERE sfdc_case_file_id = ${requiredFileId} AND store_id = ${store.id}
		`;
		if (count === 0) {
			await clearRequiredFile(requiredFileId, s3DocumentId, {
				userId: locals.user.id,
				accountId: store.account_id
			});
			return { uploadSuccess: 'Upload cleared. Slot is pending again.' };
		}
		return { uploadSuccess: 'File removed.' };
	}
};
