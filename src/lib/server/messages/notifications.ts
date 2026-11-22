/**
 * Pure aggregation of unread App Messages (Case + Store + Account) into topbar
 * notification items. Kept free of I/O so it can be unit-tested.
 *
 * Tenant safety: callers only pass messages fetched for this tenant's own
 * Salesforce ids, and destinations are built from the tenant's LOCAL store ids —
 * a message whose store/case can't be mapped back to a tenant store gets a
 * generic destination, never another tenant's data.
 */
import type { AppMessageWithContext } from '$lib/types/app-message';

export interface MessageNotificationItem {
	id: string;
	title: string;
	subtitle: string;
	href: string;
	createdAt: string | null;
}

export interface MessageNotificationInput {
	/** Unread messages already fetched per context (undefined = that context failed to load). */
	case?: AppMessageWithContext[];
	store?: AppMessageWithContext[];
	account?: AppMessageWithContext[];
	/** Signed-in user's Salesforce Contact; their own messages are excluded. */
	currentContactId: string | null;
	/** SF Store__c id → local store. */
	storeBySfdcId: Map<string, { id: string; name: string }>;
	/** SF Case id → local store (for destinations) + case number is on the message. */
	caseStoreById: Map<string, { id: string; name: string } | null>;
}

function authorOf(m: AppMessageWithContext): string {
	return m.displayName ?? m.senderContactName ?? m.createdByName ?? 'Someone';
}

export function aggregateMessageNotifications(input: MessageNotificationInput): MessageNotificationItem[] {
	const seen = new Set<string>();
	const items: MessageNotificationItem[] = [];

	const push = (m: AppMessageWithContext, subtitle: string, href: string) => {
		if (seen.has(m.Id)) return; // dedupe across contexts / overlapping fetches
		seen.add(m.Id);
		items.push({
			id: m.Id,
			title: `New message from ${authorOf(m)}`,
			subtitle,
			href,
			createdAt: m.createdAt
		});
	};
	const eligible = (m: AppMessageWithContext) =>
		!m.messageRead && !(input.currentContactId && m.senderContactId === input.currentContactId);

	for (const m of input.case ?? []) {
		if (!eligible(m)) continue;
		const store = input.caseStoreById.get(m.contextId) ?? null;
		push(
			m,
			`Case ${m.caseNumber ?? ''}${store ? ` · ${store.name}` : ''}`.trim(),
			store ? `/stores/${store.id}/issues/${m.contextId}` : '/issues'
		);
	}
	for (const m of input.store ?? []) {
		if (!eligible(m)) continue;
		const store = input.storeBySfdcId.get(m.contextId) ?? null;
		push(
			m,
			store ? `Store: ${store.name}` : 'Store',
			store ? `/stores/${store.id}#store-messages` : '/stores'
		);
	}
	for (const m of input.account ?? []) {
		if (!eligible(m)) continue;
		push(m, 'Account messages', '/accounts#account-messages');
	}

	items.sort((a, b) => {
		const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0;
		const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0;
		return tb - ta;
	});
	return items;
}
