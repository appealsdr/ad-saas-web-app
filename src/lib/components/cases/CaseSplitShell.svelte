<script lang="ts">
	/**
	 * Split view frame: a fixed-width list pane and a detail pane, each scrolling on
	 * its own. At 900px and below it becomes list-first: one pane at a time,
	 * whichever matches the selection. The detail content stays mounted while the
	 * next case loads, hidden behind a skeleton.
	 */
	export let hasSelection = false;
	export let loading = false;
	/** Changing this scrolls the detail pane back to the top. */
	export let selectionKey: string | null = null;

	let detailEl: HTMLElement;
	$: if (selectionKey !== undefined && detailEl) detailEl.scrollTop = 0;
</script>

<div class="split" class:has-selection={hasSelection}>
	<section class="list-pane" aria-label="Case list">
		<div class="list-head"><slot name="toolbar" /></div>
		<div class="list-body"><slot name="list" /></div>
	</section>
	<section class="detail-pane" aria-label="Case detail" aria-busy={loading} bind:this={detailEl}>
		{#if loading}
			<div class="skeleton" role="status">
				<span class="sr-only">Loading case…</span>
				<div class="bone title"></div>
				<div class="bone block"></div>
				<div class="bone block tall"></div>
				<div class="bone block"></div>
			</div>
		{/if}
		<div class="detail-content" hidden={loading}><slot /></div>
	</section>
</div>

<style>
	.split {
		flex: 1; min-height: 0; display: grid;
		grid-template-columns: minmax(320px, 38%) minmax(0, 1fr);
		grid-template-rows: minmax(0, 1fr);
	}
	.list-pane {
		display: flex; flex-direction: column; min-height: 0; background: white;
		border-right: 4px solid var(--grey-line);
	}
	.list-head { flex-shrink: 0; padding: 12px 16px 8px; border-bottom: 1px solid var(--grey-line); }
	.list-body { flex: 1; min-height: 0; overflow-y: auto; }
	.detail-pane { min-width: 0; min-height: 0; overflow-y: auto; }
	.detail-content:not([hidden]) { display: flex; flex-direction: column; min-height: 100%; }

	.skeleton { padding: 20px 18px; display: flex; flex-direction: column; gap: 14px; }
	.bone { border-radius: var(--radius); background: var(--grey-line); animation: pulse 1.2s ease-in-out infinite; }
	.bone.title { height: 22px; width: 40%; }
	.bone.block { height: 110px; }
	.bone.tall { height: 260px; }
	@keyframes pulse { 50% { opacity: .45; } }
	@media (prefers-reduced-motion: reduce) { .bone { animation: none; } }
	.sr-only {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}

	@media (max-width: 900px) {
		.split { grid-template-columns: minmax(0, 1fr); }
		.list-pane { border-right: 0; }
		.split.has-selection .list-pane { display: none; }
		.split:not(.has-selection) .detail-pane { display: none; }
	}
</style>
