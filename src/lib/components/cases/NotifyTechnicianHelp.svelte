<script lang="ts">
	/**
	 * The ⓘ beside "Notify technician": what the button does, when it works and what is still missing.
	 * Opens on hover, keyboard focus or tap; closes on Escape, scroll or when focus and pointer leave.
	 */

	/** Outstanding items; empty when the button can be used, null when that couldn't be checked. */
	export let todo: string[] | null;

	let trigger: HTMLButtonElement;
	let hovered = false;
	let focused = false;
	let position = '';
	$: open = hovered || focused;

	/** Fixed and clamped to the window, so no card or narrow pane can cut it off. */
	function place() {
		const box = trigger.getBoundingClientRect();
		const width = Math.min(320, window.innerWidth - 24);
		const left = Math.max(12, Math.min(box.left + box.width / 2 - width / 2, window.innerWidth - width - 12));
		position = `top:${box.bottom}px;left:${left}px;width:${width}px`;
	}
	function close() {
		hovered = false;
		focused = false;
	}

	/** Scrolling any ancestor would leave the panel behind, so it closes instead. */
	function closeOnScroll(node: HTMLElement) {
		const onScroll = (e: Event) => {
			if (!node.contains(e.target as Node)) close();
		};
		window.addEventListener('scroll', onScroll, true);
		return { destroy: () => window.removeEventListener('scroll', onScroll, true) };
	}
</script>

<svelte:window on:resize={close} on:keydown={(e) => e.key === 'Escape' && close()} />

<!-- The wrapper keeps the panel open while the pointer moves from the icon onto it. -->
<span
	class="help"
	role="presentation"
	use:closeOnScroll
	on:mouseenter={() => { place(); hovered = true; }}
	on:mouseleave={() => (hovered = false)}
>
	<button
		type="button"
		class="icon"
		bind:this={trigger}
		aria-label="About Notify technician"
		aria-describedby="notify-help"
		on:focus={() => { place(); focused = true; }}
		on:blur={() => (focused = false)}
		on:click={() => { place(); trigger.focus(); focused = true; }}
	>i</button>
	<span class="panel" class:open style={position}>
		<span class="bubble" id="notify-help" role="tooltip">
			<span class="lead">
				<b>Notify technician</b> tells our team you have finished your part. The case moves to
				<b>In Progress - Tech</b> and a technician continues working on it.
			</span>
			<span class="heading">The button works after you have:</span>
			<span class="item">• answered every question from our team in the case messages</span>
			<span class="item">• uploaded every requested document</span>
			<span class="item">• provided the onboarding information, if the case asks for it</span>
			{#if todo === null}
				<span class="state todo">We couldn't check what is still needed. Reload the page to try again.</span>
			{:else if todo.length}
				<span class="state todo">
					<b>Still needed on this case:</b>
					{#each todo as item}<span class="item">• {item}</span>{/each}
				</span>
			{:else}
				<span class="state ready">Nothing is outstanding. You can notify the technician now.</span>
			{/if}
			<span class="more">Full steps: How to Use → Tracking your cases.</span>
		</span>
	</span>
</span>

<style>
	.help { display: inline-flex; }
	.icon {
		width: 22px; height: 22px; padding: 0; display: inline-flex; align-items: center; justify-content: center;
		border: 1.5px solid var(--navy); border-radius: 50%; background: white; color: var(--navy);
		font: italic 700 13px/1 Georgia, serif; cursor: help;
	}
	.icon:hover { background: var(--orange-lt); }
	.icon:focus-visible { outline: 2px solid var(--orange); outline-offset: 2px; }
	/* The padding bridges the gap to the icon. */
	.panel { position: fixed; z-index: 60; padding-top: 8px; box-sizing: border-box; visibility: hidden; }
	.panel.open { visibility: visible; }
	.bubble {
		display: flex; flex-direction: column; gap: 5px; padding: 14px 16px;
		max-height: 60vh; overflow-y: auto;
		background: white; border: 1px solid var(--grey-line); border-radius: var(--radius-sm);
		box-shadow: 0 12px 32px rgba(0,0,0,.18);
		color: var(--navy); font-size: 13px; font-weight: 400; line-height: 1.5; text-align: left;
	}
	.heading { font-weight: 700; margin-top: 3px; }
	.item { display: block; }
	.state { display: block; margin-top: 4px; padding: 8px 10px; border-radius: var(--radius-sm); }
	.state.todo { background: var(--orange-lt); }
	.state.ready { background: #eafaf0; }
	.more { color: var(--grey-text); font-size: 12.5px; }
</style>
