/**
 * Messages tab — Slack-format view of the signed-in user's conversations.
 *
 * One conversation is shown at a time, selected by the URL:
 *   /messages                          → ACCOUNT chat   (Case_Message__c.Account__c only)
 *   /messages?store=<localStoreId>     → STORE chat     (Store__c only)
 *   /messages?store=<id>&case=<sfCase> → CASE chat      (Case__c only)
 * Each view shows ONLY messages assigned directly to that context. The left pane
 * lists every conversation with its unread count.
 *
 * Tenant safety: the selection is untrusted input. Every scope is re-resolved from
 * the session through the shared conversation module (account from the login, store
 * must belong to the user's account, case must belong to that store) — an
 * unknown/foreign id is a 404, never another tenant's messages. The actions use the
 * same resolution, driven by the form action's query string.
 *
 * The conversation and the overview are streamed so the shell renders immediately.
 */
import { fail, redirect, error } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import {
	resolveAccountScope,
	resolveStoreScope,
	resolveCaseScope,
	loadConversationSafe,
	postConversationMessage,
	markConversationRead,
	type ConversationScope
} from '$lib/server/messages/conversation';
import { loadMessagesOverview } from '$lib/server/messages/overview';
import { logError } from '$lib/server/error_log';

type User = { id: string };

/** Resolve the conversation selected by ?store= / ?case= (tenant-checked); null = not found. */
async function resolveSelectedScope(user: User, url: URL): Promise<ConversationScope | null> {
	const storeId = url.searchParams.get('store');
	const caseId = url.searchParams.get('case');
	if (caseId) return storeId ? resolveCaseScope(user, storeId, caseId) : null;
	if (storeId) return resolveStoreScope(user, storeId);
	return resolveAccountScope(user);
}

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.user) throw redirect(303, '/login');
	// AD-1968: the Messages page is only available to accounts an admin enabled it for.
	if (!(await parent()).messagesEnabled) throw redirect(303, '/dashboard');
	const user = locals.user;

	const accountScope = await resolveAccountScope(user);
	if (!accountScope) {
		return { account: null, selected: null, conversation: Promise.resolve(null), overview: Promise.resolve(null) };
	}

	const scope = await resolveSelectedScope(user, url);
	if (!scope) throw error(404, 'Conversation not found.');

	const storeId = url.searchParams.get('store');
	const caseId = url.searchParams.get('case');
	const selected = {
		kind: scope.kind,
		storeId: scope.kind === 'account' ? null : storeId,
		caseId: scope.kind === 'case' ? caseId : null,
		/** Appended to the form action so posts/read receipts target this conversation. */
		actionQuery: scope.kind === 'account' ? '' : `&store=${encodeURIComponent(storeId ?? '')}${scope.kind === 'case' ? `&case=${encodeURIComponent(caseId ?? '')}` : ''}`
	};

	const conversation = loadConversationSafe(scope, user).catch(() => null);
	const overview = sql<{ sfdc_contact_id: string | null }[]>`
		SELECT sfdc_contact_id FROM users WHERE id = ${user.id} LIMIT 1
	`
		.then(([row]) =>
			loadMessagesOverview(user, accountScope.accountId, accountScope.contextId, row?.sfdc_contact_id ?? null, selected.caseId)
		)
		.catch(async (e) => {
			await logError({
				source: 'messages.overview',
				operation: 'load',
				userId: user.id,
				accountId: accountScope.accountId,
				errorMessage: e instanceof Error ? e.message : String(e),
				stack: e instanceof Error ? e.stack : undefined
			});
			return null;
		});

	return { account: { name: accountScope.label }, selected, conversation, overview };
};

export const actions: Actions = {
	/** Post to the selected conversation only (account / store / case — its own lookup only). */
	post_message: async ({ request, locals, url }) => {
		if (!locals.user) throw redirect(303, '/login');
		const scope = await resolveSelectedScope(locals.user, url);
		if (!scope) return fail(404, { messageError: 'Conversation not found.', messageBody: '' });
		const result = await postConversationMessage(scope, locals.user, await request.formData());
		if (!result.ok) return fail(result.status, { messageError: result.error, messageBody: result.body });
		return { messageSuccess: 'Message sent.' };
	},

	/** Mark a message of the selected conversation as read. */
	mark_read: async ({ request, locals, url }) => {
		if (!locals.user) throw redirect(303, '/login');
		const scope = await resolveSelectedScope(locals.user, url);
		if (!scope) return fail(404, { readError: 'Conversation not found.' });
		const data = await request.formData();
		const result = await markConversationRead(scope, locals.user, String(data.get('messageId') ?? '').trim());
		if (!result.ok) return fail(result.status, { readError: result.error });
		return { readSuccess: true };
	}
};
