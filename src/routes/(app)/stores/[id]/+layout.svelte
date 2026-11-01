<script lang="ts">
	import { page } from '$app/stores';
	import type { LayoutData } from './$types';

	export let data: LayoutData;

	$: storeId = data.storeTab.id;
	$: tabs = [
		{ label: 'Overview', href: `/stores/${storeId}` },
		{ label: 'Plan & Services', href: `/stores/${storeId}/services` },
		...(data.storeTab.aiChatEnabled
			? [{ label: 'AI Chat', href: `/stores/${storeId}/chat` }]
			: [])
	];
	$: isActive = (href: string) =>
		href === `/stores/${storeId}` ? $page.url.pathname === href : $page.url.pathname.startsWith(href);
</script>

<nav class="store-tabs">
	{#each tabs as tab (tab.href)}
		<a class="tab" class:active={isActive(tab.href)} href={tab.href}>{tab.label}</a>
	{/each}
</nav>

<slot />

<style>
	.store-tabs {
		display: flex;
		gap: 4px;
		padding: 0 26px;
		background: white;
		border-bottom: 1px solid var(--grey-line);
		flex-shrink: 0;
	}
	.tab {
		padding: 12px 14px;
		font-size: 13px;
		font-weight: 600;
		color: var(--grey-text);
		text-decoration: none;
		border-bottom: 2px solid transparent;
	}
	.tab:hover { color: var(--navy); }
	.tab.active { color: var(--navy); border-bottom-color: var(--navy); }
</style>
