import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** "Services & cases" was split: cases live at /cases, contracts under Billing. */
export const load: PageServerLoad = ({ params }) => {
	throw redirect(308, `/admin/accounts/${params.accountId}/cases`);
};
