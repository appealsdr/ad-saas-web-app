<script lang="ts">
	/**
	 * Split view's list: Case #, Subject, Store, Service and Status only. Each selectable
	 * case is a link (Enter selects; Up/Down move between cases). Cases without a
	 * local store are shown but can't be selected.
	 */
	import Badge from '$lib/components/ui/Badge.svelte';
	import { statusVariant, type IssueRow } from '$lib/cases/case-list';

	export let cases: IssueRow[] = [];
	export let selectedId: string | null = null;
	export let hrefFor: (caseId: string) => string;

	let listEl: HTMLUListElement;

	function onKeydown(e: KeyboardEvent) {
		if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
		const links = [...listEl.querySelectorAll<HTMLAnchorElement>('a.row')];
		const at = links.indexOf(e.target as HTMLAnchorElement);
		if (at < 0) return;
		e.preventDefault();
		links[at + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<ul class="list" bind:this={listEl} on:keydown={onKeydown} aria-label="Cases" data-sveltekit-preload-data="off">
	{#each cases as c (c.Id)}
		<li>
			{#if c.localStoreId}
				<a
					class="row"
					class:selected={c.Id === selectedId}
					href={hrefFor(c.Id)}
					aria-current={c.Id === selectedId ? 'true' : undefined}
					data-sveltekit-noscroll
					data-sveltekit-keepfocus
				>
					<span class="num">{c.CaseNumber}</span>
					<span class="service">{c.recordTypeName ?? '—'}</span>
					<span class="subject" title={c.Subject ?? undefined}>{c.Subject ?? '—'}</span>
					<span class="store">{c.storeName ?? '—'}</span>
					<span class="status"><Badge variant={statusVariant(c.Status)}>{c.Status}</Badge></span>
				</a>
			{:else}
				<div class="row disabled">
					<span class="num">{c.CaseNumber}</span>
					<span class="service">{c.recordTypeName ?? '—'}</span>
					<span class="subject" title={c.Subject ?? undefined}>{c.Subject ?? '—'}</span>
					<span class="store orphan">Unlinked store</span>
					<span class="status"><Badge variant={statusVariant(c.Status)}>{c.Status}</Badge></span>
				</div>
			{/if}
		</li>
	{/each}
</ul>

<style>
	.list { list-style: none; margin: 0; padding: 0; }
	li { border-bottom: 1px solid var(--grey-line); }
	.row {
		/* Wraps rather than squeezes: the list pane is only a quarter of the screen. */
		display: flex; flex-wrap: wrap; gap: 2px 10px;
		padding: 10px 16px; font-size: 13px; color: var(--navy); text-decoration: none;
		border-left: 3px solid transparent;
	}
	a.row:hover { background: var(--grey-bg); }
	a.row:focus-visible { outline: 2px solid var(--orange); outline-offset: -2px; }
	.row.selected, a.row.selected:hover { background: var(--orange-lt); border-left-color: var(--orange); }
	.row.disabled { cursor: default; color: var(--grey-text); }
	.num { flex: 0 0 auto; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }
	.service { flex: 1 1 110px; min-width: 0; font-size: 12px; color: var(--grey-text); text-align: right; overflow-wrap: anywhere; }
	.subject, .store { min-width: 0; overflow-wrap: anywhere; }
	.subject { flex-basis: 100%; }
	.subject {
		font-weight: 500; display: -webkit-box; -webkit-box-orient: vertical;
		-webkit-line-clamp: 2; line-clamp: 2; overflow: hidden;
	}
	.store { flex: 1 1 110px; align-self: center; font-size: 12px; color: var(--grey-text); }
	.status { align-self: center; margin-left: auto; }
	.orphan { font-style: italic; }
</style>
