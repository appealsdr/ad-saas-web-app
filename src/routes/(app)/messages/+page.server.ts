/**
 * Messages tab — Slack-format view of the ACCOUNT conversation.
 *
 * Shows every message exchanged between the app and Salesforce for the signed-in
 * user's account (Case_Message__c.Account__c), plus an overview of unread
 * activity below the account: each store's own chat and the cases under it.
 *
 * Tenant safety: the Account is resolved from the session (never from the URL or
 * form), store/case ids come from the user's own local stores, and the actions
 * reuse the shared conversation module.
 *
 * Both the conversation and the overview are streamed so the page shell renders
 * immediately and each pane shows its own loading state.
 */
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import {
	resolveAccountScope,
	loadConversationSafe,
	postConversationMessage,
	markConversationRead
} from '$lib/server/messages/conversation';
import { loadMessagesOverview } from '$lib/server/messages/overview';
import { logError } from '$lib/server/error_log';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const user = locals.user;

	const scope = await resolveAccountScope(user);
	if (!scope) return { account: null, conversation: Promise.resolve(null), overview: Promise.resolve(null) };

	const conversation = loadConversationSafe(scope, user).catch(() => null);
	const overview = sql<{ sfdc_contact_id: string | null }[]>`
		SELECT sfdc_contact_id FROM users WHERE id = ${user.id} LIMIT 1
	`
		.then(([row]) => loadMessagesOverview(user, scope.accountId, scope.contextId, row?.sfdc_contact_id ?? null))
		.catch(async (e) => {
			await logError({
				source: 'messages.overview',
				operation: 'load',
				userId: user.id,
				accountId: scope.accountId,
				errorMessage: e instanceof Error ? e.message : String(e),
				stack: e instanceof Error ? e.stack : undefined
			});
			return null;
		});

	return { account: { name: scope.label }, conversation, overview };
};

export const actions: Actions = {
	/** Post an Account-level message (Account__c only; sender = the user's Contact). */
	post_message: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const scope = await resolveAccountScope(locals.user);
		if (!scope) return fail(404, { messageError: 'Account not found.', messageBody: '' });
		const result = await postConversationMessage(scope, locals.user, await request.formData());
		if (!result.ok) return fail(result.status, { messageError: result.error, messageBody: result.body });
		return { messageSuccess: 'Message sent.' };
	},

	/** Mark an Account-level message as read (only messages of this account's conversation). */
	mark_read: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const scope = await resolveAccountScope(locals.user);
		if (!scope) return fail(404, { readError: 'Account not found.' });
		const data = await request.formData();
		const result = await markConversationRead(scope, locals.user, String(data.get('messageId') ?? '').trim());
		if (!result.ok) return fail(result.status, { readError: result.error });
		return { readSuccess: true };
	}
};
