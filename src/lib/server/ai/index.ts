import { createClaudeProvider } from './claude';
import { createGeminiProvider } from './gemini';
import type { ChatProvider } from './types';

export type { ChatProvider, ChatHistoryMessage, ChatReply } from './types';
export { ChatProviderNotConfiguredError } from './types';

const providers: Record<'claude' | 'gemini', ChatProvider> = {
	claude: createClaudeProvider(),
	gemini: createGeminiProvider()
};

export function getProvider(name: 'claude' | 'gemini'): ChatProvider {
	return providers[name];
}
