/** Browser-side singleton: targeted SvelteKit invalidation for case data. */
import { invalidate } from '$app/navigation';
import { navigating } from '$app/stores';
import { get } from 'svelte/store';
import { createRefresher, CASE_DEPENDENCY, ISSUES_DEPENDENCY } from './refresh';

async function isReachable(): Promise<boolean> {
	if (navigator.onLine === false) return false;
	try {
		const res = await fetch('/icons/case.png', { method: 'HEAD', cache: 'no-store' });
		return res.status < 500;
	} catch {
		return false;
	}
}

export const refreshCaseData = createRefresher({
	invalidate: (dep) => invalidate(dep),
	isNavigating: () => !!get(navigating)?.to,
	isReachable
});

/** After a successful case mutation: the open case and the account-wide list. */
export const refreshAfterCaseMutation = () => refreshCaseData(CASE_DEPENDENCY, ISSUES_DEPENDENCY);
