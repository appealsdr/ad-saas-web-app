<script lang="ts">
	/** "Actions ▼" row menu (admin mockup). Items are links or click handlers. */
	export let items: { label: string; icon?: string; href?: string; danger?: boolean; disabled?: boolean; title?: string; run?: () => void }[];
	export let label = 'Actions';

	let open = false;
	let btn: HTMLButtonElement;
	let pos = { top: 0, left: 0 };

	function toggle() {
		if (!open) {
			const b = btn.getBoundingClientRect();
			pos = { top: Math.min(b.bottom + 4, window.innerHeight - items.length * 38 - 16), left: Math.max(8, b.right - 190) };
		}
		open = !open;
	}
	function pick(i: (typeof items)[number]) {
		open = false;
		i.run?.();
	}
</script>

<svelte:window on:keydown={(e) => open && e.key === 'Escape' && (open = false)} />

<button bind:this={btn} type="button" class="rm-btn" class:on={open} aria-haspopup="menu" aria-expanded={open} on:click={toggle}>
	{label} <span class="caret">▼</span>
</button>

{#if open}
	<div class="rm-scrim" role="presentation" on:click={() => (open = false)}></div>
	<div class="rm-menu" role="menu" style="top:{pos.top}px;left:{pos.left}px">
		{#each items as i}
			{#if i.href && !i.disabled}
				<a role="menuitem" class="rm-item" class:danger={i.danger} href={i.href} on:click={() => (open = false)}><span class="ic">{i.icon ?? ''}</span>{i.label}</a>
			{:else}
				<button type="button" role="menuitem" class="rm-item" class:danger={i.danger} disabled={i.disabled} title={i.title} on:click={() => pick(i)}><span class="ic">{i.icon ?? ''}</span>{i.label}</button>
			{/if}
		{/each}
	</div>
{/if}

<style>
	.rm-btn { display: inline-flex; align-items: center; gap: 6px; background: #fff; border: 1px solid var(--grey-line); border-radius: 8px; padding: 5px 10px; font: inherit; font-size: 12px; font-weight: 700; color: var(--navy); cursor: pointer; }
	.rm-btn:hover, .rm-btn.on { border-color: var(--navy); background: #F6F8FB; }
	.caret { font-size: 8px; }
	.rm-scrim { position: fixed; inset: 0; z-index: 1200; }
	.rm-menu { position: fixed; z-index: 1210; min-width: 190px; background: #fff; border: 1px solid var(--grey-line); border-radius: 10px; box-shadow: 0 12px 36px rgba(0,0,0,.18); padding: 6px; display: flex; flex-direction: column; }
	.rm-item { display: flex; align-items: center; gap: 8px; text-align: left; background: none; border: none; border-radius: 7px; padding: 8px 10px; font: inherit; font-size: 13px; font-weight: 600; color: var(--navy); cursor: pointer; text-decoration: none; }
	.rm-item:hover:not(:disabled) { background: #F6F8FB; }
	.rm-item.danger { color: #b91c1c; }
	.rm-item.danger:hover:not(:disabled) { background: #FEF2F2; }
	.rm-item:disabled { opacity: .45; cursor: not-allowed; }
	.ic { width: 16px; text-align: center; }
</style>
