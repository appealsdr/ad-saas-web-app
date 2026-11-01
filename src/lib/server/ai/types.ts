export type ChatRole = 'user' | 'assistant';

export interface ChatHistoryMessage {
	role: ChatRole;
	content: string;
}

export interface ChatReply {
	text: string;
	model: string;
}

export interface ChatProvider {
	readonly name: 'claude' | 'gemini';
	send(history: ChatHistoryMessage[], question: string): Promise<ChatReply>;
}

export class ChatProviderNotConfiguredError extends Error {
	constructor(provider: string) {
		super(`${provider} is not configured — missing API key.`);
		this.name = 'ChatProviderNotConfiguredError';
	}
}
