/**
 * Issue (Case) detail — the canonical full page. Loading, tenant checks and every
 * action live in $lib/server/cases/case-workspace, shared with the split view.
 */
import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { loadCaseWorkspace, createCaseActions } from '$lib/server/cases/case-workspace';
import { CASE_DEPENDENCY } from '$lib/cases/refresh';

export const load: PageServerLoad = async ({ params, locals, depends }) => {
	depends(CASE_DEPENDENCY);
	if (!locals.user) throw redirect(303, '/login');
	return loadCaseWorkspace(locals.user, params.id, params.caseId);
};

export const actions: Actions = createCaseActions<{ id: string; caseId: string }>((_user, params) => params.id);
