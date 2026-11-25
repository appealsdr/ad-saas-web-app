<script lang="ts">
	/** The full eight-column Cases table. Rows open the canonical case page. */
	import { goto } from '$app/navigation';
	import Badge from '$lib/components/ui/Badge.svelte';
	import CaseStepsCell from './CaseStepsCell.svelte';
	import {
		canonicalCaseHref,
		fmtDateShort,
		isResolved,
		isWaitingOnClient,
		priorityVariant,
		statusVariant,
		type IssueRow
	} from '$lib/cases/case-list';

	export let cases: IssueRow[] = [];
	/** Case remembered from the split view; highlighted only. */
	export let selectedId: string | null = null;

	function openRow(c: IssueRow) {
		const href = canonicalCaseHref(c); // null: the SF Case exists but its store isn't local
		if (href) goto(href);
	}
</script>

<div class="card">
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
			{#each cases as c (c.Id)}
				{@const href = canonicalCaseHref(c)}
				<tr
					class:clickable={!!href}
					class:row-waiting={isWaitingOnClient(c.Status)}
					class:selected={c.Id === selectedId}
					aria-current={c.Id === selectedId ? 'true' : undefined}
					on:click={() => openRow(c)}
				>
					<td class="case-num">
						{#if href}
							<a class="case-link" {href} data-sveltekit-preload-data="off" on:click|stopPropagation>{c.CaseNumber}</a>
						{:else}
							{c.CaseNumber}
						{/if}
					</td>
					<td class="subject">
						{c.Subject ?? '—'}
						<CaseStepsCell steps={c.steps} closed={isResolved(c.Status)} />
					</td>
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

<style>
	.card {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); overflow-x: auto; padding: 0;
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
	.data-table tbody tr.selected { box-shadow: inset 3px 0 0 var(--orange); }
	.data-table td { padding: 12px 14px; vertical-align: middle; }

	.case-num {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600;
	}
	.case-link { color: inherit; text-decoration: none; }
	.case-link:hover { text-decoration: underline; }
	.subject {
		font-weight: 500; color: var(--navy); max-width: 320px; overflow-wrap: anywhere;
	}
	.store-link {
		color: var(--orange); text-decoration: none; font-weight: 600;
	}
	.store-link:hover { text-decoration: underline; }
	.store-orphan { color: var(--grey-text); font-style: italic; }
</style>
