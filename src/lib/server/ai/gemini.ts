/**
 * Gemini chat provider. Reads GEMINI_API_KEY from env — throws
 * ChatProviderNotConfiguredError when missing so the caller can show a
 * friendly message instead of a 500.
 */
import { env } from '$env/dynamic/private';
import { ChatProviderNotConfiguredError, type ChatHistoryMessage, type ChatProvider, type ChatReply } from './types';

const DEFAULT_MODEL = 'gemini-2.5-flash';

export function createGeminiProvider(): ChatProvider {
	return {
		name: 'gemini',
		async send(history: ChatHistoryMessage[], question: string): Promise<ChatReply> {
			const apiKey = env.GEMINI_API_KEY;
			if (!apiKey) throw new ChatProviderNotConfiguredError('Gemini');

			const { GoogleGenAI } = await import('@google/genai');
			const client = new GoogleGenAI({ apiKey });
			const model = env.GEMINI_CHAT_MODEL?.trim() || DEFAULT_MODEL;

			const contents = [
				...history.map((m) => ({
					role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
					parts: [{ text: m.content }]
				})),
				{ role: 'user' as const, parts: [{ text: question }] }
			];

			const response = await client.models.generateContent({ model, contents });
			const text = (response.text ?? '').trim();

			return { text, model };
		}
	};
}
