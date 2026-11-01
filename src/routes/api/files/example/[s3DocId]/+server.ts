/**
 * GET /api/files/example/:s3DocId
 *
 * 302-redirects to a presigned S3 URL for an example file — the S3_Document__c
 * referenced by a Document_Template__c's Last_Version__c. Looks up the S3 key
 * from Salesforce (examples have no local mirror row).
 *
 * ?disposition=inline → preview; default downloads.
 */
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sfdcQuery } from '$lib/server/salesforce';
import { getDownloadUrl } from '$lib/server/storage/s3';

interface DocRow {
	S3_Key__c: string | null;
	File_Name__c: string | null;
	Content_Type__c: string | null;
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'Sign in required.');

	const inline = url.searchParams.get('disposition') === 'inline';
	const id = params.s3DocId.replace(/'/g, "''");

	let row: DocRow | undefined;
	try {
		const result = await sfdcQuery<DocRow>(
			`SELECT S3_Key__c, File_Name__c, Content_Type__c FROM S3_Document__c WHERE Id = '${id}' LIMIT 1`
		);
		row = result.records[0];
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'Could not look up the example file.');
	}
	if (!row?.S3_Key__c) throw error(404, 'Example file not found.');

	let signed: string;
	try {
		signed = await getDownloadUrl(row.S3_Key__c, row.File_Name__c ?? 'example', {
			disposition: inline ? 'inline' : 'attachment',
			contentType: inline ? row.Content_Type__c : undefined
		});
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'Could not generate the example URL.');
	}
	throw redirect(302, signed);
};
