import type { PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { listAccountDocuments } from '$lib/server/admin/accounts';

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'accounts.read');
	return { documents: await listAccountDocuments(accountId) };
};
