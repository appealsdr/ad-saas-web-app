/**
 * GET /cases/<sfdcCaseId>
 *
 * Salesforce-keyed shortcut for deep-linking from SF email templates.
 * Resolves the SF Case Id to the canonical app URL and 303s.
 *
 * Example email merge field on a "New Case" template:
 *   <a href="https://app.example.com/cases/{!Case.Id}">View case</a>
 *
 * The path is under (app), so the auth guard (which now preserves ?next)
 * sends unauthenticated users to /login?next=/cases/<id>, then back here
 * after sign-in to finish the redirect.
 */
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { findCaseStoreLookup } from '$lib/server/salesforce';

interface AccountStoreRow {
	id: string;
	sfdc_store_id: string | null;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Sign in required.');
	const sfdcCaseId = params.caseId.trim();
	if (!sfdcCaseId) throw error(400, 'Missing case id.');

	const ctx = { userId: locals.user.id };

	// 1. Ask Salesforce which store the case belongs to.
	const lookup = await findCaseStoreLookup(sfdcCaseId, ctx);
	if (!lookup.ok) {
		if (lookup.notFound) throw error(404, 'Case not found in Salesforce.');
		throw error(502, `Could not look up case: ${lookup.error}`);
	}

	if (!lookup.sfdcStoreId) {
		// Case is real but has no Store__c set. Land them on the issues
		// account-wide list so they at least see the case row.
		throw redirect(303, '/issues');
	}

	// 2. Find a local store the user owns that matches that SF Store id.
	const stores = await sql<AccountStoreRow[]>`
		SELECT s.id, s.sfdc_store_id
		FROM stores s JOIN users u ON u.id = ${locals.user.id}
		WHERE s.sfdc_store_id = ${lookup.sfdcStoreId}
		  AND s.account_id = u.account_id
		LIMIT 1
	`;
	const store = stores[0];
	if (!store) {
		// SF case exists but isn't on any of this account's stores.
		throw error(403, 'You do not have access to this case.');
	}

	// 3. Redirect to the canonical case detail URL.
	throw redirect(303, `/stores/${store.id}/issues/${sfdcCaseId}`);
};
