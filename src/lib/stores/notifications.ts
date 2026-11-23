/**
 * Shared notification state for the topbar bell and the sidebar Messages badge.
 * One in-flight request at a time, so mounting both does a single fetch.
 */
import { writable } from 'svelte/store';

export interface NotificationItem {
	id: string;
	title: string;
	subtitle: string;
	href: string;
}

export interface NotificationsState {
	items: NotificationItem[];
	total: number;
	/** Unread App Messages (Account + Store + Case) — drives the Messages tab badge. */
	messages: number;
	loading: boolean;
	error: boolean;
}

export const notifications = writable<NotificationsState>({
	items: [],
	total: 0,
	messages: 0,
	loading: true,
	error: false
});

let inflight: Promise<void> | null = null;

export function refreshNotifications(): Promise<void> {
	if (inflight) return inflight;
	notifications.update((s) => ({ ...s, loading: true, error: false }));
	inflight = (async () => {
		try {
			const res = await fetch('/api/notifications');
			if (!res.ok) throw new Error('bad response');
			const data = await res.json();
			const items: NotificationItem[] = data.items ?? [];
			notifications.set({
				items,
				total: data.total ?? items.length,
				messages: data.messages ?? 0,
				loading: false,
				error: false
			});
		} catch {
			notifications.update((s) => ({ ...s, loading: false, error: true }));
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}
