/**
 * Store-level AI Chat — only available while the store has an active
 * subscription (enforced here in addition to the tab bar hiding the link).
 *
 * One conversation per store (conversation_id = a fixed UUID derived from
 * the store's most recent thread, or a fresh one on first message).
 * Each send_message action inserts one ai_chat_messages row holding both
 * the question and the provider's answer.
 */
import { fail, redirect, error } from '@sveltejs/kit';
import { randomUUID } from 'node:crypto';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { getProvider, ChatProviderNotConfiguredError, type ChatHistoryMessage } from '$lib/server/ai';
import { logError, describeError } from '$lib/server/error_log';

interface StoreRow {
	id: string;
	account_id: string;
	name: string;
	has_active_subscription: boolean;
}

async function loadStoreWithSubscription(storeId: string, userId: string): Promise<StoreRow | null> {
	const rows = await sql<StoreRow[]>`
		SELECT s.id, s.account_id, s.name,
		       (sc.kind = 'subscription' AND sc.status = 'active') AS has_active_subscription
		FROM stores s
		JOIN users u ON u.id = ${userId}
		LEFT JOIN accounts acct ON acct.id = s.account_id
		LEFT JOIN service_contracts asub ON asub.id = acct.active_subscription_contract_id AND asub.status = 'active'
		LEFT JOIN service_contracts sc ON sc.id = COALESCE(asub.id, s.active_service_contract_id)
		WHERE s.id = ${storeId} AND s.account_id = u.account_id
		LIMIT 1
	`;
	return rows[0] ?? null;
}

interface MessageRow {
	id: string;
	conversation_id: string;
	provider: string;
	question: string;
	answer: string | null;
	status: string;
	error_message: string | null;
	created_at: Date;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const store = await loadStoreWithSubscription(params.id, locals.user.id);
	if (!store) throw error(404, 'Store not found.');
	if (!store.has_active_subscription) {
		throw error(403, 'AI Chat is only available for stores with an active subscription.');
	}

	const messages = await sql<MessageRow[]>`
		SELECT id, conversation_id, provider, question, answer, status, error_message, created_at
		FROM ai_chat_messages
		WHERE store_id = ${store.id}
		ORDER BY created_at ASC
	`;

	return {
		store: { id: store.id, name: store.name },
		messages: messages.map((m) => ({
			id: m.id,
			conversationId: m.conversation_id,
			provider: m.provider,
			question: m.question,
			answer: m.answer,
			status: m.status,
			errorMessage: m.error_message,
			createdAt: m.created_at.toISOString()
		}))
	};
};

export const actions: Actions = {
	send_message: async ({ request, params, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const store = await loadStoreWithSubscription(params.id, locals.user.id);
		if (!store) throw error(404, 'Store not found.');
		if (!store.has_active_subscription) {
			return fail(403, { error: 'AI Chat is only available for stores with an active subscription.' });
		}

		const data = await request.formData();
		const question = String(data.get('question') ?? '').trim();
		const providerName = String(data.get('provider') ?? 'claude').trim();
		if (!question) return fail(400, { error: 'Type a question first.' });
		if (question.length > 4000) return fail(400, { error: 'Question is too long (max 4000 characters).' });
		if (providerName !== 'claude' && providerName !== 'gemini') {
			return fail(400, { error: 'Unknown AI provider.' });
		}

		// Reuse the store's existing thread if it has one, else start a new one.
		const [existingThread] = await sql<{ conversation_id: string }[]>`
			SELECT conversation_id FROM ai_chat_messages
			WHERE store_id = ${store.id}
			ORDER BY created_at DESC
			LIMIT 1
		`;
		const conversationId = existingThread?.conversation_id ?? randomUUID();

		const history = await sql<{ question: string; answer: string | null }[]>`
			SELECT question, answer FROM ai_chat_messages
			WHERE conversation_id = ${conversationId} AND status = 'answered'
			ORDER BY created_at ASC
		`;
		const chatHistory: ChatHistoryMessage[] = history.flatMap((m) => [
			{ role: 'user' as const, content: m.question },
			...(m.answer ? [{ role: 'assistant' as const, content: m.answer }] : [])
		]);

		const [row] = await sql<{ id: string }[]>`
			INSERT INTO ai_chat_messages (
				account_id, store_id, user_id, conversation_id, provider, question, status
			) VALUES (
				${store.account_id}, ${store.id}, ${locals.user.id}, ${conversationId}, ${providerName}, ${question}, 'pending'
			)
			RETURNING id
		`;

		try {
			const provider = getProvider(providerName);
			const reply = await provider.send(chatHistory, question);
			await sql`
				UPDATE ai_chat_messages
				SET answer = ${reply.text}, model = ${reply.model}, status = 'answered', answered_at = now()
				WHERE id = ${row.id}
			`;
			return { success: true };
		} catch (e) {
			const isNotConfigured = e instanceof ChatProviderNotConfiguredError;
			const desc = describeError(e);
			await sql`
				UPDATE ai_chat_messages
				SET status = 'failed', error_message = ${desc.errorMessage}
				WHERE id = ${row.id}
			`;
			if (!isNotConfigured) {
				await logError({
					source: 'ai_chat',
					operation: 'send_message',
					userId: locals.user.id,
					accountId: store.account_id,
					errorMessage: desc.errorMessage,
					stack: desc.stack,
					context: { storeId: store.id, provider: providerName }
				});
			}
			return {
				success: false,
				error: isNotConfigured
					? `${providerName === 'claude' ? 'Claude' : 'Gemini'} isn't configured yet — add its API key to enable chat.`
					: 'The AI provider could not answer right now. Please try again.'
			};
		}
	}
};
