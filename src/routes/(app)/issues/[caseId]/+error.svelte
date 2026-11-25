<script lang="ts">
	/** A case that can't be opened: shown inside the detail pane, so the list survives. */
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { caseListHref, parseIssueFilter } from '$lib/cases/case-list';

	$: backHref = caseListHref({
		view: 'split',
		filter: parseIssueFilter($page.url.searchParams.get('status')),
		query: $page.url.searchParams.get('q') ?? ''
	});
</script>

<div class="detail-error" role="alert">
	<h2>{$page.status === 404 ? 'Case not available' : 'Something went wrong'}</h2>
	<p>{$page.error?.message ?? 'This case could not be loaded.'}</p>
	<div class="actions">
		<button type="button" class="btn btn-primary" on:click={() => goto($page.url, { invalidateAll: true, replaceState: true })}>
			Try again
		</button>
		<a class="btn btn-outline" href={backHref}>Back to cases</a>
	</div>
</div>

<style>
	.detail-error { margin: auto; padding: 40px 24px; text-align: center; color: var(--grey-text); }
	.detail-error h2 { font-size: 16px; color: var(--navy); margin: 0 0 6px; }
	.detail-error p { margin: 0 0 16px; }
	.actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 8px; }
</style>
