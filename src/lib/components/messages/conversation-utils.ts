/** Pure helpers for the shared conversation UI (unit-tested). */
import type { AppMessage } from '$lib/types/app-message';

export function sortMessages<T extends Pick<AppMessage, 'createdAt'>>(messages: T[]): T[] {
	return [...messages].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}

/** Case-insensitive match on author or body text. */
export function filterMessages<T extends AppMessage>(messages: T[], query: string): T[] {
	const q = query.trim().toLowerCase();
	if (!q) return messages;
	return messages.filter((m) => {
		const author = (m.displayName ?? m.senderContactName ?? m.createdByName ?? '').toLowerCase();
		const body = (m.body ?? '').replace(/<[^>]*>/g, ' ').toLowerCase();
		return author.includes(q) || body.includes(q);
	});
}

/** Id of the first unread message from someone else (anchor for the "N new" divider). */
export function firstUnreadId(
	sortedMessages: AppMessage[],
	currentContactId: string | null
): string | null {
	const m = sortedMessages.find(
		(x) => !x.messageRead && !(currentContactId && x.senderContactId === currentContactId)
	);
	return m?.Id ?? null;
}

export function isInternalSender(senderType: string | null): boolean {
	return !!senderType && senderType.toLowerCase().includes('internal');
}

export function initials(name: string | null): string {
	if (!name) return '??';
	const parts = name.trim().split(/\s+/);
	return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase() || '??';
}

/** Plain-text preview of an HTML body for reply quotes. */
export function plainPreview(html: string | null | undefined, max = 80): string {
	const plain = (html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
	return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

/** "Today" / "Yesterday" / "Nov 3, 2026" for day dividers. */
export function dayLabel(iso: string, now: Date = new Date()): string {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
	const diffDays = Math.round((startOf(now) - startOf(d)) / 86_400_000);
	if (diffDays === 0) return 'Today';
	if (diffDays === 1) return 'Yesterday';
	return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** Walk reply links up to the top-most ancestor present in `byId` (cycle-safe). */
function rootIdOf(id: string, byId: Map<string, AppMessage>): string {
	let cur = id;
	const seen = new Set<string>();
	for (;;) {
		const parent = byId.get(cur)?.replyToMessageId;
		if (!parent || !byId.has(parent) || seen.has(parent)) return cur;
		seen.add(cur);
		cur = parent;
	}
}

/**
 * The full reply history around a message: the top-most message of its chain plus
 * every reply descending from it, oldest first.
 */
export function threadFor<T extends AppMessage>(
	messages: T[],
	anyMessageId: string
): { root: T; replies: T[] } | null {
	const byId = new Map<string, AppMessage>(messages.map((m) => [m.Id, m]));
	if (!byId.has(anyMessageId)) return null;
	const rootId = rootIdOf(anyMessageId, byId);
	const members = messages.filter((m) => m.Id !== rootId && rootIdOf(m.Id, byId) === rootId);
	const sorted = sortMessages(members);
	return { root: byId.get(rootId) as T, replies: sorted };
}

/** Number of replies (all depths) under each thread root, keyed by root message id. */
export function replyCounts(messages: AppMessage[]): Map<string, number> {
	const byId = new Map(messages.map((m) => [m.Id, m]));
	const counts = new Map<string, number>();
	for (const m of messages) {
		const root = rootIdOf(m.Id, byId);
		if (root !== m.Id) counts.set(root, (counts.get(root) ?? 0) + 1);
	}
	return counts;
}
