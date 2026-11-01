/**
 * Client feedback detail — view one Client_Feedback__c record and edit its
 * text (Feedback__c only; Status__c is Salesforce/internal-owned).
 */
import { fail, redirect, error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { fetchClientFeedback, updateClientFeedbackBody } from '$lib/server/salesforce';
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

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	const sfdcAccountId = await resolveSfdcAccountId(locals.user.id);
	const result = await fetchClientFeedback(params.id, { userId: locals.user.id });
	if (!result.ok) {
		throw error(result.notFound ? 404 : 500, result.error);
	}
	if (!sfdcAccountId || result.feedback.clientAccountId !== sfdcAccountId) {
		throw error(404, 'Feedback not found.');
	}
	return { feedback: result.feedback };
};

export const actions: Actions = {
	update: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');

		const sfdcAccountId = await resolveSfdcAccountId(locals.user.id);
		if (!sfdcAccountId) {
			return fail(400, { updateError: 'No linked Salesforce account found.' });
		}

		const existing = await fetchClientFeedback(params.id, { userId: locals.user.id });
		if (!existing.ok || existing.feedback.clientAccountId !== sfdcAccountId) {
			throw error(404, 'Feedback not found.');
		}

		const data = await request.formData();
		const rawBody = String(data.get('body') ?? '').trim();
		if (!rawBody) {
			return fail(400, { updateError: 'Feedback cannot be empty.' });
		}
		const body = sanitizeMessageHtml(rawBody);

		const result = await updateClientFeedbackBody(params.id, body, { userId: locals.user.id });
		if (!result.ok) {
			return fail(500, { updateError: result.error });
		}
		return { updateSuccess: 'Feedback updated.' };
	}
};
