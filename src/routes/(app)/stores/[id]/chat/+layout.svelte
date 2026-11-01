<script lang="ts">
	import { page } from '$app/stores';
	import type { LayoutData } from './$types';

	export let data: LayoutData;

	$: storeId = $page.params.id;
	$: subtabs = [
		{ label: 'Assistants', href: `/stores/${storeId}/chat/assistants` },
		{ label: 'Ask', href: `/stores/${storeId}/chat` },
		...(data.storeTab.aiAssistantEnabled
			? [{ label: 'Assistance', href: `/stores/${storeId}/chat/assistance` }]
			: [])
	];
	$: isActive = (href: string) =>
		href === `/stores/${storeId}/chat` ? $page.url.pathname === href : $page.url.pathname.startsWith(href);
</script>

<nav class="ai-subtabs">
	{#each subtabs as tab (tab.href)}
		<a class="subtab" class:active={isActive(tab.href)} href={tab.href}>{tab.label}</a>
	{/each}
</nav>

<slot />

<style>
	.ai-subtabs {
		display: flex; gap: 4px; padding: 10px 26px 0;
		background: white; border-bottom: 1px solid var(--grey-line); flex-shrink: 0;
	}
	.subtab {
		padding: 8px 12px; font-size: 12px; font-weight: 600;
		color: var(--grey-text); text-decoration: none;
		border-bottom: 2px solid transparent; border-radius: 6px 6px 0 0;
	}
	.subtab:hover { color: var(--navy); background: var(--grey-bg); }
	.subtab.active { color: var(--navy); border-bottom-color: var(--orange); }
</style>
