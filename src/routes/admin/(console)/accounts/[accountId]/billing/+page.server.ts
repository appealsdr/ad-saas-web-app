import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	throw redirect(307, `/admin/accounts/${params.accountId}/billing/contracts`);
};
