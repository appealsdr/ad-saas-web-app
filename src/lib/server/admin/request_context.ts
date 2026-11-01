/**
 * Per-request correlation context (request id, and — once known — the acting
 * user / target account). logError() and the audit writer read it so new log
 * records can be tied back to a request without threading `event` everywhere.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
	requestId: string;
	userId?: string | null;
	accountId?: string | null;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentRequest(): RequestContext | undefined {
	return requestContext.getStore();
}

/** Record the target account for the rest of this request (e.g. admin workspace). */
export function setRequestAccount(accountId: string | null): void {
	const store = requestContext.getStore();
	if (store) store.accountId = accountId;
}
