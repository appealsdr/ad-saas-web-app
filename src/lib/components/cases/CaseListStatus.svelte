<script lang="ts">
	/** Load errors and empty states of the Cases list, identical in both views. */
	export let storesError: string | null = null;
	export let storesTotal = 0;
	export let totalCount = 0;
	export let shownCount = 0;
	export let query = '';
</script>

{#if storesError}
	<div class="alert alert-error" role="alert" style="margin-bottom:16px">
		{#if totalCount > 0}
			Could not refresh cases from Salesforce: {storesError} Showing the last loaded list.
		{:else}
			Could not load cases from Salesforce: {storesError}
		{/if}
	</div>
{/if}

{#if storesTotal === 0 && !storesError}
	<div class="empty">
		<h2>No stores yet</h2>
		<p>Add an Amazon seller account to start tracking cases.</p>
		<a href="/stores" class="btn btn-primary">Add a store →</a>
	</div>
{:else if totalCount === 0 && !storesError}
	<div class="empty">
		<h2>No cases yet</h2>
		<p>
			No Salesforce Cases linked to any of your {storesTotal} store{storesTotal === 1 ? '' : 's'} yet.
		</p>
	</div>
{:else if totalCount > 0 && shownCount === 0}
	<div class="no-match">
		{#if query.trim()}No cases match "{query}".{:else}No cases match the current filter.{/if}
	</div>
{/if}

<style>
	.empty {
		background: white; border: 1px dashed var(--grey-line);
		border-radius: var(--radius); padding: 40px 24px;
		text-align: center; color: var(--grey-text);
	}
	.empty h2 { font-size: 16px; color: var(--navy); margin: 0 0 6px; }
	.empty p { margin: 0 0 16px; }
	.no-match {
		background: white; border: 1px solid var(--grey-line); border-radius: var(--radius);
		padding: 24px; text-align: center; color: var(--grey-text); overflow-wrap: anywhere;
	}
</style>
