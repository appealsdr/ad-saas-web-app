import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/** Old overview URL → the unified contract view on the Payments page. */
export const GET: RequestHandler = ({ params }) => {
	throw redirect(308, `/payments?contract=${encodeURIComponent(params.contractId)}`);
};
