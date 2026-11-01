/**
 * GET /api/cases/:caseId/documents/:docId
 *
 * Returns a 302 redirect to a presigned S3 download URL valid for 5 minutes.
 * Authorization: the doc's store must belong to the signed-in user's account.
 */
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sql } from '$lib/server/db';
import { getDownloadUrl } from '$lib/server/storage/s3';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'Sign in required.');

	const rows = await sql<
		{ s3_key: string; original_name: string; mime_type: string | null }[]
	>`
		SELECT d.s3_key, d.original_name, d.mime_type
		FROM case_documents d
		JOIN stores s ON s.id = d.store_id
		JOIN users  u ON u.id = ${locals.user.id}
		WHERE d.id = ${params.docId}
		  AND d.sfdc_case_id = ${params.caseId}
		  AND s.account_id = u.account_id
		LIMIT 1
	`;
	const row = rows[0];
	if (!row) throw error(404, 'Document not found.');

	// ?disposition=inline → browser renders it (preview modal); default downloads.
	const inline = url.searchParams.get('disposition') === 'inline';

	let signed: string;
	try {
		signed = await getDownloadUrl(row.s3_key, row.original_name, {
			disposition: inline ? 'inline' : 'attachment',
			contentType: inline ? row.mime_type : undefined
		});
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'Could not generate download URL.');
	}
	// Throw the redirect OUTSIDE the try/catch — in SvelteKit 2 redirect() throws
	// a Redirect (not a Response), so catching it would swallow it into a 502.
	throw redirect(302, signed);
};
