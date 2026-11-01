/**
 * GET /admin/accounts/:accountId/documents/:kind/:docId/download
 *
 * Staff download of a store/case document. Ownership is enforced in SQL:
 * the document's store must belong to :accountId, so a tampered docId from
 * another account returns 404. Every download is audited.
 */
import { error, redirect } from '@sveltejs/kit';
import { createReadStream, statSync } from 'node:fs';
import { isAbsolute, join, normalize, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { env } from '$env/dynamic/private';
import { workspace } from '$lib/server/admin/workspace';
import { auditActor, clientIp, isUuid } from '$lib/server/admin/guard';
import { recordAudit } from '$lib/server/admin/audit';
import { getDownloadUrl } from '$lib/server/storage/s3';

interface Row {
	original_name: string;
	mime_type: string | null;
	s3_key: string | null;
	storage_path: string | null;
}

export const GET: RequestHandler = async (event) => {
	const { staff, accountId } = await workspace(event, 'accounts.read');
	const { kind, docId } = event.params;
	const inline = event.url.searchParams.get('disposition') === 'inline';
	if (!isUuid(docId) || (kind !== 'store' && kind !== 'case')) throw error(404, 'Not found.');

	const rows =
		kind === 'store'
			? await sql<Row[]>`
				SELECT d.original_name, d.mime_type, d.s3_key, d.storage_path
				FROM store_documents d JOIN stores s ON s.id = d.store_id
				WHERE d.id = ${docId} AND s.account_id = ${accountId}`
			: await sql<Row[]>`
				SELECT d.original_name, d.mime_type, d.s3_key, NULL::text AS storage_path
				FROM case_documents d JOIN stores s ON s.id = d.store_id
				WHERE d.id = ${docId} AND s.account_id = ${accountId}`;
	const row = rows[0];
	if (!row) throw error(404, 'Document not found in this account.');

	await recordAudit({
		actor: auditActor(staff),
		action: inline ? 'document.preview' : 'document.download',
		targetType: `${kind}_document`,
		targetId: docId,
		targetAccountId: accountId,
		outcome: 'success',
		ip: clientIp(event),
		metadata: { fileName: row.original_name }
	}); // audited BEFORE any bytes/URL are released; failure aborts the download

	if (row.s3_key) {
		let url: string;
		try {
			url = await getDownloadUrl(row.s3_key, row.original_name, {
				disposition: inline ? 'inline' : 'attachment',
				contentType: inline ? row.mime_type : undefined
			});
		} catch {
			throw error(502, 'Could not generate a download URL.');
		}
		throw redirect(302, url);
	}
	if (row.storage_path) {
		const raw = env.UPLOADS_DIR?.trim() || './uploads';
		const root = isAbsolute(raw) ? raw : join(process.cwd(), raw);
		const abs = normalize(join(root, row.storage_path));
		if (!abs.startsWith(normalize(root) + sep)) throw error(404, 'Not found.');
		try {
			const st = statSync(abs);
			return new Response(Readable.toWeb(createReadStream(abs)) as ReadableStream, {
				headers: {
					'content-type': row.mime_type ?? 'application/octet-stream',
					'content-length': String(st.size),
					'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(row.original_name)}"`,
					'x-content-type-options': 'nosniff'
				}
			});
		} catch {
			throw error(404, 'File is missing from storage.');
		}
	}
	throw error(404, 'No stored file for this document.');
};
