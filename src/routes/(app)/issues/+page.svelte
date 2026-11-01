<script lang="ts">
	import { goto } from '$app/navigation';
	import Topbar from '$components/layout/Topbar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	type IssueFilter = 'all' | 'open' | 'in_progress' | 'waiting' | 'resolved';
	let filter: IssueFilter = 'all';

	// Same status keyword taxonomy as /stores/[id] — keep them aligned so
	// counts/filters mean the same thing on both pages.
	function matchesFilter(status: string, f: IssueFilter): boolean {
		if (f === 'all') return true;
		const s = status.toLowerCase();
		if (f === 'open') return s.includes('open') || s === 'new';
		if (f === 'in_progress') return s.includes('progress') || s.includes('working');
		if (f === 'waiting') return s.includes('waiting') || s.includes('pending') || s.includes('awaiting');
		if (f === 'resolved') return s.includes('closed') || s.includes('resolved');
		return false;
	}

	let query = '';
	$: filtered = (data.issues ?? []).filter((c) => {
		if (!matchesFilter(c.Status, filter)) return false;
		if (!query.trim()) return true;
		const q = query.toLowerCase();
		return (
			c.CaseNumber.toLowerCase().includes(q) ||
			(c.Subject ?? '').toLowerCase().includes(q) ||
			(c.storeName ?? '').toLowerCase().includes(q)
		);
	});

	function statusVariant(s: string): 'green' | 'orange' | 'grey' | 'red' {
		const ls = s.toLowerCase();
		if (ls.includes('closed') || ls.includes('resolved')) return 'green';
		if (ls.includes('waiting') || ls.includes('pending') || ls.includes('awaiting')) return 'red';
		if (ls.includes('progress') || ls.includes('working')) return 'orange';
		return 'grey'; // Open / New
	}
	function isWaitingOnClient(s: string): boolean {
		const ls = s.toLowerCase();
		return ls.includes('waiting') || ls.includes('pending') || ls.includes('awaiting');
	}
	function priorityVariant(p: string | null): 'red' | 'orange' | 'grey' {
		if (!p) return 'grey';
		const lp = p.toLowerCase();
		if (lp.includes('critical') || lp.includes('high')) return 'red';
		if (lp.includes('medium')) return 'orange';
		return 'grey';
	}
	function fmtDateShort(iso: string | null | undefined) {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
	}

	function rowHref(c: PageData['issues'][number]): string | null {
		if (!c.localStoreId) return null; // SF Case exists but its store isn't local — no deep link target
		return `/stores/${c.localStoreId}/issues/${c.Id}`;
	}
	function openRow(c: PageData['issues'][number]) {
		const href = rowHref(c);
		if (href) goto(href);
	}
</script>

<svelte:head><title>Cases — Appeals Doctor</title></svelte:head>

<Topbar title="Cases" subtitle="Cases across all your stores" />

<div class="content-area">
	<!-- ── Header bar: search + filters + count ───────────────────────── -->
	<div class="bar">
		<div class="search-wrap">
			<input
				type="search"
				class="form-control"
				placeholder="Search by case #, subject, or store…"
				bind:value={query}
			/>
		</div>
		<div class="filter-tabs">
			<button class:active={filter === 'all'}         on:click={() => filter = 'all'}>All</button>
			<button class:active={filter === 'open'}        on:click={() => filter = 'open'}>Open</button>
			<button class:active={filter === 'in_progress'} on:click={() => filter = 'in_progress'}>In progress</button>
			<button class:active={filter === 'waiting'}     on:click={() => filter = 'waiting'}>Waiting</button>
			<button class:active={filter === 'resolved'}    on:click={() => filter = 'resolved'}>Resolved</button>
		</div>
		<div class="count">
			{filtered.length} of {data.issues.length}
			· {data.storesTotal} store{data.storesTotal === 1 ? '' : 's'}
		</div>
	</div>

	{#if data.storesError}
		<div class="alert alert-error" style="margin-bottom:16px">
			Could not load cases from Salesforce: {data.storesError}
		</div>
	{/if}

	{#if data.storesTotal === 0}
		<div class="empty">
			<h2>No stores yet</h2>
			<p>Add an Amazon seller account to start tracking cases.</p>
			<a href="/stores" class="btn btn-primary">Add a store →</a>
		</div>
	{:else if data.issues.length === 0 && !data.storesError}
		<div class="empty">
			<h2>No cases yet</h2>
			<p>
				No Salesforce Cases linked to any of your {data.storesTotal} store{data.storesTotal === 1 ? '' : 's'} yet.
			</p>
		</div>
	{:else if filtered.length === 0}
		<div class="card" style="padding:24px;text-align:center;color:var(--grey-text)">
			{#if query.trim()}No cases match "{query}".{:else}No cases match the current filter.{/if}
		</div>
	{:else}
		<div class="card" style="padding:0">
			<table class="data-table">
				<thead>
					<tr>
						<th>Case #</th>
						<th>Subject</th>
						<th>Store</th>
						<th>Service</th>
						<th>Status</th>
						<th>Priority</th>
						<th>Opened</th>
						<th>Last modified</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as c (c.Id)}
						<tr
							class:clickable={!!c.localStoreId}
							class:row-waiting={isWaitingOnClient(c.Status)}
							on:click={() => openRow(c)}
						>
							<td class="case-num">{c.CaseNumber}</td>
							<td class="subject">{c.Subject ?? '—'}</td>
							<td>
								{#if c.localStoreId && c.storeName}
									<a class="store-link"
										href={`/stores/${c.localStoreId}`}
										on:click|stopPropagation
									>{c.storeName}</a>
								{:else}
									<span class="store-orphan">Unlinked store</span>
								{/if}
							</td>
							<td>{c.recordTypeName ?? '—'}</td>
							<td><Badge variant={statusVariant(c.Status)}>{c.Status}</Badge></td>
							<td>
								{#if c.Priority}<Badge variant={priorityVariant(c.Priority)}>{c.Priority}</Badge>{:else}—{/if}
							</td>
							<td>{fmtDateShort(c.CreatedDate)}</td>
							<td>{fmtDateShort(c.LastModifiedDate)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }

	.bar {
		display: flex; align-items: center; flex-wrap: wrap;
		gap: 16px; margin-bottom: 16px;
	}
	.search-wrap { flex: 1; min-width: 220px; max-width: 360px; }
	.count { font-size: 13px; color: var(--grey-text); margin-left: auto; }

	.filter-tabs {
		display: flex; gap: 4px; background: #fafafa;
		border-radius: 8px; padding: 3px;
	}
	.filter-tabs button {
		background: transparent; border: none; padding: 6px 12px;
		font-size: 12px; font-weight: 600; color: var(--grey-text);
		border-radius: 6px; cursor: pointer; transition: all .15s;
	}
	.filter-tabs button:hover { color: var(--navy); }
	.filter-tabs button.active {
		background: white; color: var(--navy);
		box-shadow: 0 1px 2px rgba(0,0,0,.06);
	}

	.card {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); overflow: hidden;
	}
	.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
	.data-table thead th {
		text-align: left; padding: 10px 14px; font-size: 11px;
		font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
		color: var(--grey-text); border-bottom: 1px solid var(--grey-line);
		background: #fafafa;
	}
	.data-table tbody tr { border-bottom: 1px solid var(--grey-line); transition: background-color .12s; }
	.data-table tbody tr:last-child { border-bottom: none; }
	.data-table tbody tr.clickable { cursor: pointer; }
	.data-table tbody tr.clickable:hover { background: #fafafa; }
	.data-table tbody tr.row-waiting { border-left: 3px solid #b91c1c; background: #fef2f2; }
	.data-table tbody tr.row-waiting:hover { background: #fee2e2; }
	.data-table td { padding: 12px 14px; vertical-align: middle; }

	.case-num {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600;
	}
	.subject {
		font-weight: 500; color: var(--navy); max-width: 320px;
	}
	.store-link {
		color: var(--orange); text-decoration: none; font-weight: 600;
	}
	.store-link:hover { text-decoration: underline; }
	.store-orphan { color: var(--grey-text); font-style: italic; }

	.empty {
		background: white; border: 1px dashed var(--grey-line);
		border-radius: var(--radius); padding: 40px 24px;
		text-align: center; color: var(--grey-text);
	}
	.empty h2 { font-size: 16px; color: var(--navy); margin: 0 0 6px; }
	.empty p { margin: 0 0 16px; }
</style>
