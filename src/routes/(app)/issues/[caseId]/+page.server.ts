/**
 * Split view detail pane: the same case workspace and actions as
 * /stores/[id]/issues/[caseId], with the store looked up from the Case (and
 * restricted to the signed-in user's account).
 *
 * A temporary failure is returned as `loadError` instead of thrown, so the pane
 * can keep showing what it already has; "not found" still throws (the case is no
 * longer available to this user).
 */
import { redirect, isHttpError, isRedirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	loadCaseWorkspace,
	resolveStoreIdForCase,
	createCaseActions,
	UNVERIFIED_MESSAGE,
	type CaseWorkspaceData
} from '$lib/server/cases/case-workspace';
import { logError, describeError } from '$lib/server/error_log';
import { CASE_DEPENDENCY } from '$lib/cases/refresh';

export const load: PageServerLoad = async ({ params, locals, depends }) => {
	depends(CASE_DEPENDENCY);
	if (!locals.user) throw redirect(303, '/login');
	const caseId = params.caseId;
	const failed = (loadError: string) => ({ caseId, workspace: null as CaseWorkspaceData | null, loadError: loadError as string | null });

	try {
		const storeId = await resolveStoreIdForCase(locals.user, caseId);
		if (!storeId) return failed(UNVERIFIED_MESSAGE);
		const workspace: CaseWorkspaceData | null = await loadCaseWorkspace(locals.user, storeId, caseId);
		return { caseId, workspace, loadError: null as string | null };
	} catch (e) {
		if (isRedirect(e) || (isHttpError(e) && e.status < 500)) throw e;
		if (isHttpError(e)) return failed(e.body.message);
		const desc = describeError(e);
		await logError({
			source: 'cases.split_detail',
			operation: 'load',
			userId: locals.user.id,
			errorMessage: desc.errorMessage,
			stack: desc.stack,
			context: { caseId }
		});
		return failed('Could not load this case right now. Please try again.');
	}
};

export const actions: Actions = createCaseActions<{ caseId: string }>((user, params) =>
	resolveStoreIdForCase(user, params.caseId)
);
