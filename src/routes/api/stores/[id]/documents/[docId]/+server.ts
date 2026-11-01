/**
 * GET /api/stores/:id/documents/:docId
 *
 * Streams a store-level uploaded document back to the user.
 *
 * Two storage backends supported (legacy uploads use the first):
 *   1. Local FS — row has `storage_path`; we stream from disk.
 *   2. S3 — row has `s3_key`; we 302 to a presigned URL (5-min TTL).
 *
 * Tenancy: the document's store must belong to the user's account.
 */
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { env } from '$env/dynamic/private';
import { createReadStream, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { getDownloadUrl } from '$lib/server/storage/s3';

function uploadsRoot(): string {
	const raw = env.UPLOADS_DIR?.trim() || './uploads';
	return isAbsolute(raw) ? raw : join(process.cwd(), raw);
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'Sign in required.');

	// ?disposition=inline → browser renders it (preview modal); default downloads.
	const inline = url.searchParams.get('disposition') === 'inline';

	const rows = await sql<
		{
			storage_path: string | null;
			s3_key: string | null;
			original_name: string;
			mime_type: string | null;
		}[]
	>`
		SELECT d.storage_path, d.s3_key, d.original_name, d.mime_type
		FROM store_documents d
		JOIN stores s ON s.id = d.store_id
		JOIN users  u ON u.id = ${locals.user.id}
		WHERE d.id = ${params.docId}
		  AND s.id = ${params.id}
		  AND s.account_id = u.account_id
		LIMIT 1
	`;
	const row = rows[0];
	if (!row) throw error(404, 'Document not found.');

	// S3-backed (new uploads via required-file slots)
	if (row.s3_key) {
		let signed: string;
		try {
			signed = await getDownloadUrl(row.s3_key, row.original_name, {
				disposition: inline ? 'inline' : 'attachment',
				contentType: inline ? row.mime_type : undefined
			});
		} catch (e) {
			throw error(502, e instanceof Error ? e.message : 'Could not generate download URL.');
		}
		// Throw the redirect OUTSIDE try/catch — SvelteKit 2 redirect() throws a
		// Redirect (not a Response); catching it would swallow it into a 502.
		throw redirect(302, signed);
	}

	// Legacy local-FS storage (pre-migration uploads)
	if (row.storage_path) {
		const absolute = join(uploadsRoot(), row.storage_path);
		try {
			const stat = statSync(absolute);
			const stream = createReadStream(absolute);
			return new Response(stream as unknown as ReadableStream, {
				headers: {
					'Content-Type': row.mime_type ?? 'application/octet-stream',
					'Content-Length': String(stat.size),
					'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(row.original_name)}"`,
					'Cache-Control': 'private, no-store'
				}
			});
		} catch {
			throw error(404, 'File missing on disk.');
		}
	}

	throw error(500, 'Document has no storage backend.');
};
