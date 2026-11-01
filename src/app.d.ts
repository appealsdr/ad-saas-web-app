import type { User } from '$lib/types';
import type { StaffContext } from '$lib/server/admin/sessions';

// Extend SvelteKit's Locals and PageData types
declare global {
	namespace App {
		interface Locals {
			user: User | null;
			/** Platform staff identity — only set on /admin paths after full MFA login. */
			staff: StaffContext | null;
			requestId: string;
			/** Admin "view as user" session: browse only. */
			readOnly: boolean;
			impersonatedBy: string | null;
			/** Customer session context for activity tracking. */
			accountId: string | null;
			sessionId: string | null;
		}
		interface PageData {
			user?: User | null;
			readOnly?: boolean;
			impersonatedBy?: string | null;
		}
		// interface Error {}
		// interface Platform {}
	}
}

export {};
