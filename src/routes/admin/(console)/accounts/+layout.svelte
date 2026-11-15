<script lang="ts">
	import { navigating, page } from '$app/stores';
	// Sub-tabs of the Accounts area. Hidden on a single account's pages (/admin/accounts/<id>/…), which have their own tabs.
	const tabs: [string, string][] = [
		['/admin/accounts', 'All accounts'],
		['/admin/accounts/merge', 'Account merge'],
		['/admin/accounts/provision', 'Account provision']
	];
	$: path = ($navigating?.to?.url.pathname ?? $page.url.pathname).replace(/\/$/, '');
	$: showTabs = tabs.some(([href]) => path === href);
</script>

{#if showTabs}
	<nav class="subtabs" aria-label="Accounts sections">
		{#each tabs as [href, label]}
			<a {href} aria-current={path === href ? 'page' : undefined}>{label}</a>
		{/each}
	</nav>
{/if}
<slot />

<style>
	.subtabs { display: flex; gap: 2px; margin-bottom: 16px; border-bottom: 1px solid var(--grey-line); }
	.subtabs a { padding: 10px 16px; font-size: 14px; font-weight: 600; color: var(--grey-text); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
	.subtabs a:hover { color: var(--navy); }
	.subtabs a[aria-current='page'] { color: var(--navy); border-bottom-color: var(--orange); }
	.subtabs a:focus-visible { outline: 3px solid var(--orange); outline-offset: -3px; }
</style>
