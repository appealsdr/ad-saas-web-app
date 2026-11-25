/**
 * GET /api/files/example/:s3DocId
 *
 * 302-redirects to a presigned S3 URL for an example file — the S3_Document__c
 * referenced by a Document_Template__c's Last_Version__c. Examples have no
 * local mirror row, so everything is looked up in Salesforce.
 *
 * Access: only when that template backs a required-file slot on one of the
 * signed-in user's stores, or on a case of one of those stores. Any other
 * S3_Document__c id (someone else's upload, a template they have no slot for)
 * is a 404.
 *
 * ?disposition=inline → preview (safe types only); default downloads.
 */
import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sfdcQuery } from '$lib/server/salesforce';
import { sql } from '$lib/server/db';
import { getDownloadUrl } from '$lib/server/storage/s3';
import { isSalesforceId, soqlList, soqlString } from '$lib/server/salesforce/soql';

interface SlotRow {
	Document_Template__r: {
		Last_Version__r: { S3_Key__c: string | null; File_Name__c: string | null; Content_Type__c: string | null } | null;
	} | null;
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'Sign in required.');

	const inline = url.searchParams.get('disposition') === 'inline';
	const id = params.s3DocId;
	if (!isSalesforceId(id)) throw error(404, 'Example file not found.');

	const stores = await sql<{ sfdc_store_id: string }[]>`
		SELECT s.sfdc_store_id FROM stores s JOIN users u ON u.account_id = s.account_id
		WHERE u.id = ${locals.user.id} AND s.sfdc_store_id IS NOT NULL`;
	const storeIds = stores.map((s) => s.sfdc_store_id).filter(isSalesforceId);
	if (!storeIds.length) throw error(404, 'Example file not found.');

	let file: NonNullable<SlotRow['Document_Template__r']>['Last_Version__r'] | undefined;
	try {
		const mine = soqlList(storeIds);
		const result = await sfdcQuery<SlotRow>(
			`SELECT Document_Template__r.Last_Version__r.S3_Key__c, Document_Template__r.Last_Version__r.File_Name__c,
			 Document_Template__r.Last_Version__r.Content_Type__c FROM Required_File__c
			 WHERE Document_Template__r.Last_Version__c = ${soqlString(id)}
			 AND (Store__c IN (${mine}) OR Case__r.Store__c IN (${mine})) LIMIT 1`
		);
		file = result.records[0]?.Document_Template__r?.Last_Version__r;
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'Could not look up the example file.');
	}
	if (!file?.S3_Key__c) throw error(404, 'Example file not found.');

	let signed: string;
	try {
		signed = await getDownloadUrl(file.S3_Key__c, file.File_Name__c ?? 'example', {
			disposition: inline ? 'inline' : 'attachment',
			contentType: file.Content_Type__c
		});
	} catch (e) {
		throw error(502, e instanceof Error ? e.message : 'Could not generate the example URL.');
	}
	throw redirect(302, signed);
};
