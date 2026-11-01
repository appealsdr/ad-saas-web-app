<script lang="ts">
	import NotificationBell from './NotificationBell.svelte';
	import FeedbackButton from './FeedbackButton.svelte';
	import { page } from '$app/stores';
	import { buildCrumbs, type Crumb } from '$lib/breadcrumbs';
	export let title: string;
	export let subtitle = '';
	/** Override the trail derived from the current route. */
	export let crumbs: Crumb[] | null = null;

	$: trail = crumbs ?? buildCrumbs($page.url.pathname, $page.data);
</script>

<header class="topbar">
	<div class="topbar-left">
		<div class="page-title">{title}</div>
		{#if subtitle}<div class="page-sub">{subtitle}</div>{/if}
	</div>
	<div class="topbar-right">
		<slot />
		<FeedbackButton />
		<NotificationBell />
	</div>
</header>

{#if trail.length > 1}
	<nav class="crumbs" aria-label="Breadcrumb">
		{#each trail as c, i}
			{#if i > 0}<span class="sep" aria-hidden="true">/</span>{/if}
			{#if c.href}
				<a href={c.href}>{c.label}</a>
			{:else}
				<span class="current" aria-current="page">{c.label}</span>
			{/if}
		{/each}
	</nav>
{/if}

<style>
	.crumbs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		padding: 12px 26px 0;
		font-size: 12px;
		color: var(--grey-text);
		flex-shrink: 0;
	}
	.crumbs a { color: var(--grey-text); text-decoration: none; }
	.crumbs a:hover { color: var(--navy); text-decoration: underline; }
	.crumbs .current { color: var(--navy); font-weight: 600; }

	.topbar {
		background: white;
		border-bottom: 1px solid var(--grey-line);
		padding: 0 26px;
		height: var(--topbar-h);
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex-shrink: 0;
	}

	.page-title {
		font-size: 17px;
		font-weight: 700;
		color: var(--navy);
	}

	.page-sub {
		font-size: 12px;
		color: var(--grey-text);
		margin-top: 1px;
	}

	.topbar-right {
		display: flex;
		align-items: center;
		gap: 10px;
	}
</style>
