import { writable, derived } from 'svelte/store';
import type { User } from '$types';

// ─── Auth store ───────────────────────────────────────────────────
// Populated server-side via +layout.server.ts and passed as `data.user`
// The store is the client-side mirror — UI reacts to it.

function createAuthStore() {
	const { subscribe, set, update } = writable<User | null>(null);

	return {
		subscribe,
		set,
		// Call after successful login / Google callback
		login(user: User) {
			set(user);
		},
		// Call on logout — session cookie deletion handled by the server action
		logout() {
			set(null);
		},
		// Partial update (e.g. after profile edit)
		patch(fields: Partial<User>) {
			update((u) => (u ? { ...u, ...fields } : u));
		}
	};
}

export const auth = createAuthStore();

// Convenience derived
export const isLoggedIn = derived(auth, ($u) => $u !== null);
export const userInitials = derived(auth, ($u) => {
	if (!$u) return '';
	const parts = ($u.displayName || $u.email).split(' ');
	return parts
		.slice(0, 2)
		.map((p) => p[0]?.toUpperCase() ?? '')
		.join('');
});
