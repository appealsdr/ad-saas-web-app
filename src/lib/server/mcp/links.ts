/**
 * Deep links into the web app for records the MCP tools return (AD-1969), so the customer can open the exact page.
 * Links carry ids only (never tokens or personal data) and need the normal sign-in, so a leaked link opens nothing.
 * Built from ORIGIN; without an https ORIGIN no links are produced (fail quiet — tools still work).
 */
import { env } from '$env/dynamic/private';

export const appOrigin = (): string | null => {
	const o = (env.ORIGIN || '').replace(/\/$/, '');
	return /^https:\/\//.test(o) ? o : null;
};

const enc = encodeURIComponent;

export interface AppLinks {
	store(storeId: string): string | undefined;
	storeDocuments(storeId: string): string | undefined;
	storeMessages(storeId: string): string | undefined;
	case(storeId: string, caseId: string): string | undefined;
}

export function makeLinks(origin: string | null = appOrigin()): AppLinks {
	const at = (path: string) => (origin ? `${origin}${path}` : undefined);
	return {
		store: (s) => at(`/stores/${enc(s)}`),
		storeDocuments: (s) => at(`/stores/${enc(s)}#store-documents`),
		storeMessages: (s) => at(`/stores/${enc(s)}#store-messages`),
		case: (s, c) => at(`/stores/${enc(s)}/issues/${enc(c)}`)
	};
}

/** Adds `url` only when a link could be built. */
export const withUrl = <T extends object>(obj: T, url: string | undefined): T & { url?: string } => (url ? { ...obj, url } : obj);

/** `[label](url)`, or just the label when there is no link. Labels are stripped of characters that would break markdown. */
export const mdLink = (label: string, url: string | undefined) => {
	const l = label.replace(/[\[\]\n\r]/g, ' ').trim();
	return url ? `[${l}](${url})` : l;
};
