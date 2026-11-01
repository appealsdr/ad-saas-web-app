<script lang="ts">
	import { onMount } from 'svelte';

	interface NotificationItem {
		id: string;
		title: string;
		subtitle: string;
		href: string;
	}

	let open = false;
	let loading = true;
	let error = false;
	let items: NotificationItem[] = [];
	let total = 0;

	async function load() {
		loading = true;
		error = false;
		try {
			const res = await fetch('/api/notifications');
			if (!res.ok) throw new Error('bad response');
			const data = await res.json();
			items = data.items ?? [];
			total = data.total ?? items.length;
		} catch {
			error = true;
		} finally {
			loading = false;
		}
	}

	function toggle() {
		open = !open;
		if (open) load();
	}

	function close() {
		open = false;
	}

	function handleWindowClick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		if (!target.closest('.notif-wrap')) close();
	}

	onMount(load);
</script>

<svelte:window on:click={handleWindowClick} />

<div class="notif-wrap">
	<button
		type="button"
		class="notif-btn"
		on:click|stopPropagation={toggle}
		aria-label="Notifications"
		aria-haspopup="true"
		aria-expanded={open}
	>
		<img class="bell-icon" src="/icons/notification.png" alt="" aria-hidden="true" />
		{#if total > 0}
			<span class="notif-count">{total > 9 ? '9+' : total}</span>
		{/if}
	</button>

	{#if open}
		<div class="notif-dropdown" role="menu">
			<div class="notif-hdr">Notifications</div>
			{#if loading}
				<div class="notif-empty">Loading…</div>
			{:else if error}
				<div class="notif-empty">Could not load notifications.</div>
			{:else if items.length === 0}
				<div class="notif-empty">You're all caught up — nothing needs action.</div>
			{:else}
				{#each items as item (item.id)}
					<a class="notif-item" href={item.href} on:click={close}>
						<div class="notif-item-title">{item.title}</div>
						<div class="notif-item-sub">{item.subtitle}</div>
					</a>
				{/each}
			{/if}
			<a class="notif-more" href="/dashboard" on:click={close}>View more →</a>
		</div>
	{/if}
</div>

<style>
	.notif-wrap { position: relative; }
	.notif-btn {
		position: relative;
		background: none; border: none; cursor: pointer;
		line-height: 1; padding: 6px;
		border-radius: 8px; color: var(--navy);
		display: flex; align-items: center; justify-content: center;
	}
	.notif-btn:hover { background: var(--grey-bg, #f3f4f6); }
	.bell-icon { width: 13px; height: 13px; object-fit: contain; display: block; }
	.notif-count {
		position: absolute; top: 0; right: 0;
		background: #b91c1c; color: white; font-size: 10px; font-weight: 700;
		min-width: 16px; height: 16px; border-radius: 8px;
		display: flex; align-items: center; justify-content: center;
		padding: 0 3px; transform: translate(30%, -30%);
	}
	.notif-dropdown {
		position: absolute; top: calc(100% + 8px); right: 0; z-index: 1000;
		width: 320px; background: white; border: 1px solid var(--grey-line);
		border-radius: 12px; box-shadow: var(--shadow-lg, 0 12px 32px rgba(0,0,0,.14));
		overflow: hidden;
	}
	.notif-hdr {
		padding: 12px 14px; font-size: 13px; font-weight: 700; color: var(--navy);
		border-bottom: 1px solid var(--grey-line);
	}
	.notif-empty {
		padding: 20px 14px; font-size: 12px; color: var(--grey-text); text-align: center;
	}
	.notif-item {
		display: block; padding: 10px 14px; text-decoration: none; color: inherit;
		border-bottom: 1px solid var(--grey-line); transition: background .12s;
	}
	.notif-item:hover { background: #fafafa; }
	.notif-item-title { font-size: 12px; font-weight: 700; color: var(--navy); }
	.notif-item-sub { font-size: 11px; color: var(--grey-text); margin-top: 2px; }
	.notif-more {
		display: block; text-align: center; padding: 10px 14px;
		font-size: 12px; font-weight: 600; color: var(--orange, #ea580c);
		text-decoration: none;
	}
	.notif-more:hover { text-decoration: underline; }
</style>
