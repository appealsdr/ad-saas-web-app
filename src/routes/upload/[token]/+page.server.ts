/**
 * /upload/[token] — one-time browser upload for ONE required-file slot (AD-1969).
 * No login: the token IS the credential (256-bit, hashed at rest, single use, 15 min). Everything about the target
 * (account, store, case, slot, acting user) comes from the stored link, never from the browser.
 * Uploads run through the same pipeline as the API: format + content sniffing + virus scan + Salesforce sync.
 */
import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { ApiError } from '$lib/server/integrations/errors';
import { requireIntegrationStore, requireIntegrationCase, requireIntegrationRequiredFile, requireIntegrationStoreRequiredFile } from '$lib/server/integrations/resources';
import { recordIntegrationEvent } from '$lib/server/integrations/audit';
import { mcpAvailable } from '$lib/server/mcp/killswitch';
import { findUsableLink, claimLink, releaseLink, recordLinkUpload, type UploadLink } from '$lib/server/mcp/upload_links';
import { storeRequiredFileUpload, validateUpload, extensionOf, MAX_UPLOAD_BYTES, MIME_EXTENSIONS } from '$lib/server/files/required_file_upload';
import { htmlToText } from '$lib/server/sanitize';
import { logError, describeError } from '$lib/server/error_log';

const MAX_MB = MAX_UPLOAD_BYTES / 1024 / 1024;

/** Same page for every bad token — never reveal whether a token existed, was used or expired. */
const UNUSABLE = { state: 'unusable' as const };

async function target(link: UploadLink) {
	const store = await requireIntegrationStore(link.account_id, link.store_id);
	if (link.sfdc_case_id) await requireIntegrationCase(store, link.sfdc_case_id, link.account_id);
	const slot = link.sfdc_case_id
		? await requireIntegrationRequiredFile(link.sfdc_case_id, link.required_file_id)
		: await requireIntegrationStoreRequiredFile(store, link.required_file_id);
	return { store, slot };
}

const mimeFor = (ext: string) => Object.entries(MIME_EXTENSIONS).find(([, exts]) => exts.includes(ext))?.[0] ?? '';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
	setHeaders({ 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY' });
	const link = await findUsableLink(params.token);
	if (!link) return UNUSABLE;
	if (!(await mcpAvailable(link.account_id)).ok) return { state: 'disabled' as const };
	try {
		const { slot } = await target(link);
		return {
			state: 'ready' as const,
			slotName: slot.name,
			description: slot.shortDescription,
			instructions: slot.instructions ? htmlToText(slot.instructions).slice(0, 600) : null,
			acceptedFormats: slot.acceptedFormats.map((f) => f.replace(/^\./, '').toLowerCase()).filter(Boolean),
			maxMb: MAX_MB,
			expiresAt: link.expires_at.toISOString()
		};
	} catch (e) {
		if (e instanceof ApiError) return UNUSABLE;
		throw e;
	}
};

export const actions: Actions = {
	upload: async ({ params, request, setHeaders, getClientAddress }) => {
		setHeaders({ 'cache-control': 'no-store' });
		const link = await findUsableLink(params.token);
		if (!link) return fail(410, { error: 'This link has expired or was already used. Ask the assistant for a new one.' });
		if (!(await mcpAvailable(link.account_id)).ok) return fail(503, { error: 'Uploads are temporarily unavailable.' });

		const fd = await request.formData();
		const file = fd.get('file');
		if (!(file instanceof File) || file.size === 0) return fail(400, { error: 'Choose a file first.' });
		if (file.size > MAX_UPLOAD_BYTES) return fail(413, { error: `The file is larger than ${MAX_MB} MB.` });

		const ext = extensionOf(file.name);
		const input = { contentType: mimeFor(ext), fileName: file.name, bytes: new Uint8Array(await file.arrayBuffer()), replaceExisting: link.replace_existing };
		let t: Awaited<ReturnType<typeof target>>;
		try {
			t = await target(link);
			validateUpload(t.slot, input); // friendly rejection BEFORE the link is spent
		} catch (e) {
			if (e instanceof ApiError) return fail(e.status, { error: e.message });
			throw e;
		}

		if (!(await claimLink(link.id))) return fail(410, { error: 'This link was already used. Ask the assistant for a new one.' });
		const audit = (outcome: string, extra: { httpStatus?: number; errorCode?: string } = {}) => recordIntegrationEvent({
			integrationId: link.integration_id, accountId: link.account_id, defaultUserId: link.created_by_user_id,
			requiredPermission: 'files.upload', operation: 'upload_link.upload', resourceType: 'required_file', resourceId: t.slot.id,
			outcome, sourceIp: getClientAddress(), metadata: { fileName: file.name.slice(0, 120), sizeBytes: file.size }, ...extra
		});
		try {
			const r = await storeRequiredFileUpload({ store: t.store, caseId: link.sfdc_case_id ?? undefined, userId: link.created_by_user_id, slot: t.slot }, input);
			await recordLinkUpload(link.id, file.name);
			await audit('success', { httpStatus: 201 });
			return { done: true as const, fileName: r.fileName, sizeBytes: r.sizeBytes, synced: r.salesforceSynced };
		} catch (e) {
			await releaseLink(link.id).catch(() => {}); // let the customer retry with the same link until it expires
			if (e instanceof ApiError) {
				await audit('failure', { httpStatus: e.status, errorCode: e.code });
				return fail(e.status, { error: e.message });
			}
			const d = describeError(e);
			await logError({ source: 'upload_link', operation: 'upload', accountId: link.account_id, errorMessage: d.errorMessage, stack: d.stack });
			await audit('failure', { httpStatus: 500, errorCode: 'INTERNAL_ERROR' });
			return fail(500, { error: 'Something went wrong. Please try again.' });
		}
	}
};
