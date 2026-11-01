/** Subscriptions moved to the account level — keep old links/bookmarks working. */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	throw redirect(301, '/accounts/subscription');
};
