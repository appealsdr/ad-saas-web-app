/**
 * Store detail page.
 *
 * Loaded:
 *   - Local store row
 *   - SF Cases for the store (Issues section)
 *   - SF Case_File__c rows where Store__c = <storeId> AND Case__c = null
 *     (store-level required-file checklist) joined with local store_documents
 *
 * Actions:
 *   edit_store    — PATCH local row + Salesforce Store__c
 *   upload_doc    — slot-keyed: PUT to S3, UPSERT local row,
 *                   PATCH Case_File__c.Client_File_Info__c = s3://<bucket>/<key>.
 *                   Re-upload UPSERTs the same row + deletes the prior S3 object.
 *   clear_doc     — reverse: DELETE S3 + local row + clear SF Client_File_Info__c.
 *
 * SP-API reconnect is a plain link to /auth/spapi?store=<id>.
 */
import { fail, redirect, error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { accountContracts } from '$lib/server/admin/billing';
import {
	updateSalesforceStore,
	createSalesforceStore,
	getStoreMarketplaceOptions,
	fetchStoreMetrics,
	listCasesForStore,
	listRequiredFilesForStore,
	attachUploadToRequiredFile,
	clearRequiredFile
} from '$lib/server/salesforce';
import { putObject, deleteObject, getRegion } from '$lib/server/storage/s3';
import { storeFileKey } from '$lib/server/storage/s3-paths';
import { logError, describeError } from '$lib/server/error_log';
import { canManageAccountContacts } from '$lib/server/auth/roles';
import { ensureOwnerAccountContact, getDefaultStorePointOfContactId } from '$lib/server/account/contacts';
import { basename } from 'node:path';
import { randomUUID } from 'node:crypto';

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

function normalizeMarketplaces(raw: string): string | null {
	const parts = raw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
	return parts.length ? parts.join(';') : null;
}

interface StoreRow {
	id: string;
	account_id: string;
	name: string;
	marketplaces: string | null;
	seller_id: string | null;
	seller_primary_email: string | null;
	store_email: string | null;
	business_name: string | null;
	country: string | null;
	description: string | null;
	sfdc_store_id: string | null;
	spapi_status: string;
	spapi_connected_at: Date | null;
	spapi_connected_seller_id: string | null;
	spapi_last_error: string | null;
	point_of_contact_id: string | null;
	active_service_contract_id: string | null;
	created_at: Date;
	updated_at: Date;
}

async function loadStore(storeId: string, userId: string): Promise<StoreRow | null> {
	const rows = await sql<StoreRow[]>`
		SELECT s.*
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
	s3_bucket: string | null;
	s3_key: string | null;
	created_at: Date;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const store = await loadStore(params.id, locals.user.id);
	if (!store) throw error(404, 'Store not found.');

	await ensureOwnerAccountContact(store.account_id);

	if (!store.point_of_contact_id) {
		const defaultPocId = await getDefaultStorePointOfContactId(store.account_id);
		if (defaultPocId) {
			await sql`
				UPDATE stores SET point_of_contact_id = ${defaultPocId}
				WHERE id = ${store.id}
			`;
			store.point_of_contact_id = defaultPocId;
		}
	}

	const [actor, accountContacts, pointOfContact] = await Promise.all([
		sql<{ role: string }[]>`
			SELECT role FROM users WHERE id = ${locals.user.id} LIMIT 1
		`.then((rows) => rows[0] ?? null),
		sql<{
			id: string;
			first_name: string | null;
			last_name: string;
			email: string;
			phone: string | null;
			title: string | null;
			is_point_of_contact: boolean;
			user_role: string | null;
		}[]>`
			SELECT ac.id, ac.first_name, ac.last_name, ac.email, ac.phone, ac.title,
			       ac.is_point_of_contact, u.role AS user_role
			FROM account_contacts ac
			LEFT JOIN users u ON u.id = ac.user_id
			WHERE ac.account_id = ${store.account_id}
			ORDER BY ac.is_point_of_contact DESC, ac.last_name, ac.first_name
		`,
		store.point_of_contact_id
			? sql<{
					id: string;
					first_name: string | null;
					last_name: string;
					email: string;
					phone: string | null;
					title: string | null;
				}[]>`
				SELECT id, first_name, last_name, email, phone, title
				FROM account_contacts
				WHERE id = ${store.point_of_contact_id} AND account_id = ${store.account_id}
				LIMIT 1
			`.then((rows) => rows[0] ?? null)
			: Promise.resolve(null)
	]);

	const ctx = { userId: locals.user.id, accountId: store.account_id };

	const marketplaceOptions = await getStoreMarketplaceOptions();

	const [metrics, accountRow, subscriptionRow] = await Promise.all([
		store.sfdc_store_id
			? fetchStoreMetrics(store.sfdc_store_id, ctx)
			: Promise.resolve({
					totalRevenueRecovered: null,
					totalClosedCases: null,
					totalOpenCases: null,
					totalCases: null,
					storeHealth: null
				}),
		sql<{ id: string; name: string }[]>`
			SELECT id, name FROM accounts WHERE id = ${store.account_id} LIMIT 1
		`.then((rows) => rows[0] ?? null),
		// Subscriptions are account-level; fall back to the store's one-off contract.
		sql<{ kind: string; product_name: string | null }[]>`
			SELECT sc.kind, scli.product_name
			FROM service_contracts sc
			LEFT JOIN LATERAL (
				SELECT product_name FROM service_contract_line_items
				WHERE service_contract_id = sc.id ORDER BY created_at ASC LIMIT 1
			) scli ON TRUE
			WHERE sc.status = 'active'
			  AND sc.id = COALESCE(
			        (SELECT a.active_subscription_contract_id FROM accounts a WHERE a.id = ${store.account_id}),
			        ${store.active_service_contract_id}
			      )
		`.then((rows) => rows[0] ?? null)
	]);

	// SF Cases for the Issues section (existing).
	const casesResult = store.sfdc_store_id
		? await listCasesForStore(store.sfdc_store_id, ctx)
		: null;
	const cases = casesResult && casesResult.ok ? casesResult.cases : [];
	const casesError = casesResult && !casesResult.ok ? casesResult.error : null;

	// Required_File__c (store-level) + local upload mirror.
	const [filesResult, uploads] = await Promise.all([
		store.sfdc_store_id
			? listRequiredFilesForStore(store.sfdc_store_id)
			: Promise.resolve({ ok: true as const, files: [] }),
		sql<LocalUploadRow[]>`
			SELECT id, sfdc_case_file_id, original_name, mime_type, size_bytes,
			       s3_bucket, s3_key, created_at
			FROM store_documents
			WHERE store_id = ${store.id}
			  AND sfdc_case_file_id IS NOT NULL
		`
	]);

	const localByReqId = new Map<string, LocalUploadRow[]>();
	for (const u of uploads) {
		const list = localByReqId.get(u.sfdc_case_file_id) ?? [];
		list.push(u);
		localByReqId.set(u.sfdc_case_file_id, list);
	}

	const requiredFiles = (filesResult.ok ? filesResult.files : []).map((f) => {
		const localList = (localByReqId.get(f.id) ?? []).sort((a, b) => b.created_at.getTime() - a.created_at.getTime());
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
	const filesError = filesResult.ok ? null : filesResult.error;

	return {
		store: {
			id: store.id,
			name: store.name,
			marketplaces: store.marketplaces,
			sellerId: store.seller_id,
			sellerPrimaryEmail: store.seller_primary_email,
			storeEmail: store.store_email,
			businessName: store.business_name,
			country: store.country,
			description: store.description,
			sfdcStoreId: store.sfdc_store_id,
			spapiStatus: store.spapi_status as 'connected' | 'disconnected' | 'error',
			spapiConnectedAt: store.spapi_connected_at?.toISOString() ?? null,
			spapiConnectedSellerId: store.spapi_connected_seller_id,
			spapiLastError: store.spapi_last_error,
			pointOfContactId: store.point_of_contact_id,
			createdAt: store.created_at.toISOString(),
			updatedAt: store.updated_at.toISOString()
		},
		pointOfContact: pointOfContact
			? {
					id: pointOfContact.id,
					firstName: pointOfContact.first_name ?? undefined,
					lastName: pointOfContact.last_name,
					email: pointOfContact.email,
					phone: pointOfContact.phone ?? undefined,
					title: pointOfContact.title ?? undefined
				}
			: null,
		accountContacts: accountContacts.map((c) => ({
			id: c.id,
			firstName: c.first_name ?? undefined,
			lastName: c.last_name,
			email: c.email,
			phone: c.phone ?? undefined,
			title: c.title ?? undefined,
			isPointOfContact: c.is_point_of_contact,
			userRole: c.user_role ?? undefined
		})),
		userRole: (actor?.role ?? 'member') as 'owner' | 'admin' | 'member',
		canManageContacts: canManageAccountContacts(actor?.role),
		marketplaceOptions,
		metrics,
		account: accountRow,
		subscription: subscriptionRow
			? { kind: subscriptionRow.kind, planName: subscriptionRow.product_name ?? 'Plan' }
			: null,
		requiredFiles,
		filesError,
		cases,
		casesError,
		...(await storeBilling(store.account_id, store.id))
	};
};

/** Contracts bought for this store and their payments (Salesforce Payment__c), shown as tabs next to the cases. */
async function storeBilling(accountId: string, storeId: string) {
	try {
		const { contracts, paymentsError } = await accountContracts(accountId, { storeId });
		return {
			billingError: paymentsError,
			contracts: contracts.map((c) => ({
				id: c.id,
				ref: c.ref,
				services: c.lines.map((l) => l.name).join(' + ') || 'Service contract',
				startDate: c.startDate,
				endDate: c.endDate,
				status: c.status,
				total: c.lines.length ? c.lines.reduce((n, l) => n + l.qty * l.unit, 0) : c.amount,
				paid: c.payments.filter((p) => !p.isLine && p.status === 'paid').reduce((n, p) => n + p.amount, 0),
				paymentCount: c.payments.filter((p) => !p.isLine).length
			})),
			storePayments: contracts
				.flatMap((c) => c.payments.map((p) => ({ ...p, contractRef: c.ref })))
				.sort((a, b) => b.date.localeCompare(a.date))
				.map((p) => ({ key: p.key, sfId: p.sfId, name: p.name, contractId: p.contractId, contractRef: p.contractRef, kind: p.kind, amount: p.amount, status: p.status, date: p.date, isLine: p.isLine }))
		};
	} catch {
		return { billingError: 'Could not load contracts and payments right now.', contracts: [], storePayments: [] };
	}
}

export const actions: Actions = {
	edit_store: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		const data = await request.formData();
		const name               = String(data.get('name') ?? '').trim();
		const marketplaces       = String(data.get('marketplaces') ?? '').trim();
		const sellerId           = String(data.get('sellerId') ?? '').trim();
		const sellerPrimaryEmail = String(data.get('sellerPrimaryEmail') ?? '').trim();
		const storeEmail         = String(data.get('storeEmail') ?? '').trim();
		const businessName       = String(data.get('businessName') ?? '').trim();
		const country            = String(data.get('country') ?? '').trim();
		const description        = String(data.get('description') ?? '').trim();

		const echo = {
			name, marketplaces, sellerId, sellerPrimaryEmail,
			storeEmail, businessName, country, description
		};
		if (!name) return fail(400, { ...echo, error: 'Store name is required.' });

		const marketplacesNorm = marketplaces ? normalizeMarketplaces(marketplaces) : null;

		try {
			await sql`
				UPDATE stores SET
					name = ${name},
					marketplaces = ${marketplacesNorm},
					seller_id = ${sellerId || null},
					seller_primary_email = ${sellerPrimaryEmail || null},
					store_email = ${storeEmail || null},
					business_name = ${businessName || null},
					country = ${country || null},
					description = ${description || null}
				WHERE id = ${store.id}
			`;
		} catch (e) {
			const desc = describeError(e);
			await logError({
				source: 'stores.edit_store',
				operation: 'update_local',
				userId: locals.user.id,
				accountId: store.account_id,
				errorMessage: desc.errorMessage,
				stack: desc.stack,
				context: { storeId: store.id }
			});
			return fail(500, { ...echo, error: 'Could not save the changes.' });
		}

		if (store.sfdc_store_id) {
			const result = await updateSalesforceStore(
				store.sfdc_store_id,
				{
					name,
					marketplaces: marketplacesNorm,
					sellerId: sellerId || null,
					sellerPrimaryEmail: sellerPrimaryEmail || null,
					storeEmail: storeEmail || null,
					businessName: businessName || null,
					country: country || null,
					description: description || null
				},
				{ userId: locals.user.id, accountId: store.account_id, localStoreId: store.id }
			);
			if (!result.ok) {
				return fail(502, {
					...echo,
					savedLocally: true,
					error: `Saved locally but Salesforce rejected: ${result.error}`
				});
			}
			return { ...echo, success: 'Store updated locally and in Salesforce.' };
		}
		return { ...echo, success: 'Store updated. Will sync to Salesforce once linked.' };
	},

	/**
	 * Retry creating the Salesforce Store__c for this store when it never
	 * synced (e.g. sign-up's Salesforce call failed). No-op if already linked.
	 */
	sync_store: async ({ params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		if (store.sfdc_store_id) {
			return { syncSuccess: 'Already synced to Salesforce.' };
		}

		const [account] = await sql<{ sfdc_account_id: string | null }[]>`
			SELECT sfdc_account_id FROM accounts WHERE id = ${store.account_id} LIMIT 1
		`;

		const result = await createSalesforceStore(
			{
				name: store.name,
				sfdcAccountId: account?.sfdc_account_id ?? null,
				marketplaces: store.marketplaces,
				sellerId: store.seller_id,
				sellerPrimaryEmail: store.seller_primary_email,
				storeEmail: store.store_email,
				businessName: store.business_name,
				country: store.country,
				description: store.description
			},
			{ userId: locals.user.id, accountId: store.account_id, localStoreId: store.id }
		);
		if (!result.ok) {
			return fail(502, { syncError: `Salesforce sync failed: ${result.error}` });
		}

		await sql`UPDATE stores SET sfdc_store_id = ${result.sfdcStoreId} WHERE id = ${store.id}`;
		return { syncSuccess: 'Store synced to Salesforce.' };
	},

	set_store_point_of_contact: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStore(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');

		const [actor] = await sql<{ role: string }[]>`
			SELECT role FROM users WHERE id = ${locals.user.id} LIMIT 1
		`;
		if (!canManageAccountContacts(actor?.role)) {
			return fail(403, { pocError: 'Only account owners and admins can change the store point of contact.' });
		}

		const data = await request.formData();
		const contactId = String(data.get('contactId') ?? '').trim();
		if (!contactId) return fail(400, { pocError: 'Select a contact.' });

		const [contact] = await sql<{ id: string }[]>`
			SELECT id FROM account_contacts
			WHERE id = ${contactId} AND account_id = ${store.account_id}
			LIMIT 1
		`;
		if (!contact) return fail(404, { pocError: 'Contact not found on this account.' });

		await sql`
			UPDATE stores SET point_of_contact_id = ${contactId}
			WHERE id = ${store.id}
		`;

		return { pocSuccess: 'Store point of contact updated.' };
	},

	/**
	 * Upload one or many files into a single store-level Required_File__c slot.
	 * Body: multipart with { file (repeatable), requiredFileId, replaceDocId? }.
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
				return fail(400, { uploadError: `${file.name} is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB).` });
			}
			if (file.type && !ALLOWED_MIME.has(file.type)) {
				return fail(400, { uploadError: `Unsupported file type for ${file.name}: ${file.type}` });
			}
		}

		const uploaded: string[] = [];
		const sfIssues: string[] = [];

		for (const file of files) {
			const newDocId = randomUUID();
			const s3Key = storeFileKey({
				accountId: store.account_id,
				storeId: store.id,
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
					source: 'stores.upload_doc',
					operation: 's3_put',
					userId: locals.user.id,
					accountId: store.account_id,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: { storeId: store.id, requiredFileId, s3Key }
				});
				return fail(502, {
					uploadError: uploadedSummary(uploaded, 'Could not upload to S3. Check AWS credentials and bucket access.')
				});
			}

			// Local mirror row — one per file, several per slot.
			try {
				await sql`
					INSERT INTO store_documents (
						id, store_id, sfdc_case_file_id, uploaded_by,
						original_name, s3_bucket, s3_key, mime_type, size_bytes
					)
					VALUES (
						${newDocId}, ${store.id}, ${requiredFileId}, ${locals.user.id},
						${file.name}, ${bucket}, ${s3Key}, ${file.type || null}, ${file.size}
					)
				`;
			} catch (e) {
				await deleteObject(s3Key);
				const desc = describeError(e);
				await logError({
					source: 'stores.upload_doc',
					operation: 'insert_row',
					userId: locals.user.id,
					accountId: store.account_id,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: { storeId: store.id, requiredFileId, s3Key }
				});
				return fail(500, { uploadError: uploadedSummary(uploaded, `Uploaded ${file.name} but could not index it.`) });
			}

			// S3_Document__c (Related_Record_Id__c = Store__c Id); newest file becomes Last_Version__c.
			let sfResult: { ok: true } | { ok: false; error: string } = { ok: true };
			if (store.sfdc_store_id) {
				sfResult = await attachUploadToRequiredFile(
					{
						requiredFileId,
						relatedRecordId: store.sfdc_store_id,
						relatedObjectType: 'Store__c',
						bucket,
						key: s3Key,
						region: getRegion(),
						fileName: file.name,
						contentType: file.type || null,
						sizeBytes: file.size
					},
					{ userId: locals.user.id, accountId: store.account_id }
				);
			}
			uploaded.push(file.name);
			if (!sfResult.ok) sfIssues.push(`${file.name}: ${sfResult.error}`);
		}

		if (replaceDocId) {
			const old = await sql<{ s3_key: string }[]>`
				DELETE FROM store_documents
				WHERE id = ${replaceDocId} AND sfdc_case_file_id = ${requiredFileId} AND store_id = ${store.id}
				RETURNING s3_key
			`;
			if (old[0]?.s3_key) await deleteObject(old[0].s3_key);
		}

		const label = uploaded.length === 1 ? uploaded[0] : `${uploaded.length} files`;
		if (sfIssues.length) {
			return { uploadSuccess: `Uploaded ${label}, but Salesforce sync had an issue: ${sfIssues.join('; ')}.` };
		}
		return { uploadSuccess: `Uploaded ${label}.` };
	},

	/**
	 * Remove uploads from one Required_File__c slot. With `docId`, only that file goes;
	 * without it, every file in the slot. Once the slot is empty, Last_Version__c /
	 * File_Uploaded__c are reset and the S3_Document__c tombstoned.
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
			? await sql<{ s3_key: string | null }[]>`
					DELETE FROM store_documents
					WHERE id = ${docId} AND sfdc_case_file_id = ${requiredFileId} AND store_id = ${store.id}
					RETURNING s3_key
				`
			: await sql<{ s3_key: string | null }[]>`
					DELETE FROM store_documents
					WHERE sfdc_case_file_id = ${requiredFileId} AND store_id = ${store.id}
					RETURNING s3_key
				`;
		for (const r of rows) if (r.s3_key) await deleteObject(r.s3_key);

		const [{ count }] = await sql<{ count: number }[]>`
			SELECT count(*)::int AS count FROM store_documents
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
