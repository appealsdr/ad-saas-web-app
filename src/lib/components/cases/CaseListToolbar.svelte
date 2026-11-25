<script lang="ts">
	/** Search, quick status badges, view selector and counts — shared by both Cases views. */
	import { ISSUE_FILTERS, type IssueFilter, type CaseViewMode } from '$lib/cases/case-list';

	export let query = '';
	export let filter: IssueFilter = 'all';
	export let view: CaseViewMode = 'table';
	export let shownCount = 0;
	export let totalCount = 0;
	export let storesTotal = 0;
	export let onSearch: (query: string) => void = () => {};
	export let onFilter: (filter: IssueFilter) => void = () => {};
	export let onView: (view: CaseViewMode) => void = () => {};

	const VIEWS: { id: CaseViewMode; label: string }[] = [
		{ id: 'table', label: 'Table' },
		{ id: 'split', label: 'Split' }
	];
</script>

<div class="bar">
	<div class="search-wrap">
		<input
			type="search"
			class="form-control"
			placeholder="Search by case #, subject, or store…"
			aria-label="Search cases"
			value={query}
			on:input={(e) => onSearch(e.currentTarget.value)}
		/>
	</div>
	<div class="segmented" role="group" aria-label="Filter by status">
		{#each ISSUE_FILTERS as f (f.id)}
			<button type="button" class:active={filter === f.id} aria-pressed={filter === f.id} on:click={() => onFilter(f.id)}>
				{f.label}
			</button>
		{/each}
	</div>
	<div class="segmented" role="group" aria-label="View">
		{#each VIEWS as v (v.id)}
			<button type="button" class:active={view === v.id} aria-pressed={view === v.id} on:click={() => onView(v.id)}>
				{v.label}
			</button>
		{/each}
	</div>
	<div class="count">
		{shownCount} of {totalCount}
		· {storesTotal} store{storesTotal === 1 ? '' : 's'}
	</div>
</div>

<style>
	.bar {
		display: flex; align-items: center; flex-wrap: wrap;
		gap: 16px; margin-bottom: 16px;
	}
	.bar:last-child { margin-bottom: 0; }
	.search-wrap { flex: 1; min-width: 220px; max-width: 360px; }
	.count { font-size: 13px; color: var(--grey-text); margin-left: auto; }

	.segmented {
		display: flex; flex-wrap: wrap; gap: 4px; background: #fafafa;
		border-radius: 8px; padding: 3px;
	}
	.segmented button {
		background: transparent; border: none; padding: 6px 12px;
		font-size: 12px; font-weight: 600; color: var(--grey-text);
		border-radius: 6px; cursor: pointer; transition: all .15s;
	}
	.segmented button:hover { color: var(--navy); }
	.segmented button:focus-visible { outline: 2px solid var(--orange); outline-offset: 1px; }
	.segmented button.active {
		background: white; color: var(--navy);
		box-shadow: 0 1px 2px rgba(0,0,0,.06);
	}
</style>
