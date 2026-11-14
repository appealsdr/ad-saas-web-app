import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => ({ email: (url.searchParams.get('email') ?? '').slice(0, 254) });
