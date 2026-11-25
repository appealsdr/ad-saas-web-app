<script lang="ts">
	/**
	 * Split view with no case selected. (The table and the case list are rendered by
	 * +layout.svelte, which keeps them mounted while the selection changes.)
	 */
	import { page } from '$app/stores';
	import { filterIssues, parseIssueFilter } from '$lib/cases/case-list';
	import type { PageData } from './$types';

	export let data: PageData;

	$: selectable = filterIssues(
		data.issues,
		parseIssueFilter($page.url.searchParams.get('status')),
		$page.url.searchParams.get('q') ?? ''
	).some((c) => c.localStoreId);
</script>

<div class="empty-detail">
	{#if selectable}
		<h2>No case selected</h2>
		<p>Select a case from the list to see its details here.</p>
	{:else}
		<h2>Nothing to show</h2>
		<p>No matching case can be opened. Try a different search or status.</p>
	{/if}
</div>

<style>
	.empty-detail { margin: auto; padding: 40px 24px; text-align: center; color: var(--grey-text); }
	.empty-detail h2 { font-size: 16px; color: var(--navy); margin: 0 0 6px; }
	.empty-detail p { margin: 0; }
</style>
