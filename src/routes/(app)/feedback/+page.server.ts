/**
 * Client feedback list — all Client_Feedback__c records for the current
 * user's Salesforce Account. Creation happens here too (a new feedback
 * always starts as Status__c = 'New').
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { listClientFeedback, createClientFeedback } from '$lib/server/salesforce';
import { sanitizeMessageHtml } from '$lib/server/sanitize';

async function resolveSfdcAccountId(userId: string): Promise<string | null> {
	const [row] = await sql<{ sfdc_account_id: string | null; account_sfdc_account_id: string | null }[]>`
		SELECT u.sfdc_account_id, a.sfdc_account_id AS account_sfdc_account_id
		FROM users u
		LEFT JOIN accounts a ON a.id = u.account_id
		WHERE u.id = ${userId}
		LIMIT 1
	`;
	return row?.sfdc_account_id ?? row?.account_sfdc_account_id ?? null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const sfdcAccountId = await resolveSfdcAccountId(locals.user.id);
	if (!sfdcAccountId) {
		return { feedback: [], feedbackError: null as string | null };
	}

	const ctx = { userId: locals.user.id };
	const result = await listClientFeedback(sfdcAccountId, ctx);
	if (!result.ok) {
		return { feedback: [], feedbackError: result.error };
	}
	return { feedback: result.feedback, feedbackError: null as string | null };
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const sfdcAccountId = await resolveSfdcAccountId(locals.user.id);
		if (!sfdcAccountId) {
			return fail(400, { createError: 'No linked Salesforce account found.' });
		}

		const data = await request.formData();
		const rawBody = String(data.get('body') ?? '').trim();
		if (!rawBody) {
			return fail(400, { createError: 'Feedback cannot be empty.' });
		}
		const body = sanitizeMessageHtml(rawBody);

		const result = await createClientFeedback(
			{ accountId: sfdcAccountId, body },
			{ userId: locals.user.id }
		);
		if (!result.ok) {
			return fail(500, { createError: result.error });
		}
		throw redirect(303, `/feedback/${result.id}`);
	}
};
