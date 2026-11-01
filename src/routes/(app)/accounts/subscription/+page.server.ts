/** Plans are a pop-up on the Account page; keep old links working. */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	throw redirect(303, '/accounts?plans=1');
};
