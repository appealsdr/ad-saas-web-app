/**
 * Claude chat provider. Reads ANTHROPIC_API_KEY from env — throws
 * ChatProviderNotConfiguredError when missing so the caller can show a
 * friendly message instead of a 500.
 */
import { env } from '$env/dynamic/private';
import { ChatProviderNotConfiguredError, type ChatHistoryMessage, type ChatProvider, type ChatReply } from './types';

const DEFAULT_MODEL = 'claude-sonnet-5';

export function createClaudeProvider(): ChatProvider {
	return {
		name: 'claude',
		async send(history: ChatHistoryMessage[], question: string): Promise<ChatReply> {
			const apiKey = env.ANTHROPIC_API_KEY;
			if (!apiKey) throw new ChatProviderNotConfiguredError('Claude');

			const { default: Anthropic } = await import('@anthropic-ai/sdk');
			const client = new Anthropic({ apiKey });
			const model = env.ANTHROPIC_CHAT_MODEL?.trim() || DEFAULT_MODEL;

			const response = await client.messages.create({
				model,
				max_tokens: 1024,
				messages: [
					...history.map((m) => ({
						role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
						content: m.content
					})),
					{ role: 'user' as const, content: question }
				]
			});

			const text = response.content
				.filter((b) => b.type === 'text')
				.map((b) => (b.type === 'text' ? b.text : ''))
				.join('\n')
				.trim();

			return { text, model };
		}
	};
}
