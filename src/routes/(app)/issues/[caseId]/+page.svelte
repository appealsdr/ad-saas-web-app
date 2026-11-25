<script lang="ts">
	/** Split view detail pane: the shared case workspace for the selected case. */
	import { browser } from '$app/environment';
	import { page } from '$app/stores';
	import CaseWorkspace from '$components/cases/CaseWorkspace.svelte';
	import { caseListHref, matchesIssueFilter, parseIssueFilter, type IssueRow } from '$lib/cases/case-list';
	import { CASE_DEPENDENCY } from '$lib/cases/refresh';
	import { refreshCaseData } from '$lib/cases/refresh-client';
	import type { CaseWorkspaceData } from '$lib/server/cases/case-workspace';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	// A failed refresh keeps showing the same case's last loaded workspace.
	let lastLoaded: CaseWorkspaceData | null = null;
	$: if (data.workspace) lastLoaded = data.workspace;
	$: workspace = data.workspace ?? (lastLoaded?.case.Id === data.caseId ? lastLoaded : null);

	$: filter = parseIssueFilter($page.url.searchParams.get('status'));
	$: backHref = caseListHref({
		view: 'split',
		filter,
		query: $page.url.searchParams.get('q') ?? ''
	});

	const retry = () => void refreshCaseData(CASE_DEPENDENCY);

	// The list saw a newer version of this case than the pane shows: reload it (once).
	let requested = '';
	function reloadIfStale(row: IssueRow | undefined, shown: CaseWorkspaceData | null) {
		if (!row || !shown || row.Id !== shown.case.Id) return;
		if (!matchesIssueFilter(row.Status, filter)) return; // the selection is about to move on
		if (!(Date.parse(row.LastModifiedDate) > Date.parse(shown.case.LastModifiedDate))) return;
		const version = `${row.Id}:${row.LastModifiedDate}`;
		if (version === requested) return;
		requested = version;
		retry();
	}
	$: if (browser) reloadIfStale(data.issues.find((c) => c.Id === data.caseId), workspace);
</script>

{#if data.loadError}
	<div class="alert alert-error notice" role="alert">
		<span>
			{data.loadError}
			{#if workspace}Showing the last loaded version.{/if}
		</span>
		<button type="button" class="btn btn-outline" on:click={retry}>Try again</button>
		{#if !workspace}<a class="btn btn-outline" href={backHref}>Back to cases</a>{/if}
	</div>
{/if}

{#if workspace}
	{#key workspace.case.Id}
		<CaseWorkspace
			data={workspace}
			{form}
			mode="split"
			canonicalHref={`/stores/${workspace.storeId}/issues/${workspace.case.Id}`}
			{backHref}
		/>
	{/key}
{/if}

<style>
	.notice { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 16px 18px 0; }
	.notice span { flex: 1; min-width: 200px; }
</style>
