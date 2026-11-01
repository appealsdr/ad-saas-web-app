<script lang="ts">
	import '../app.css';
	import { auth } from '$stores/auth';
	import { readOnlyGuard } from '$lib/readOnlyGuard';
	import { onDestroy } from 'svelte';
	import { afterNavigate } from '$app/navigation';
	import { createActivityTracker } from '$lib/activityTracker';
	import type { LayoutData } from './$types';

	export let data: LayoutData;

	// Hydrate the auth store from server-provided session data
	$: if (data.user) {
		auth.set(data.user);
	}

	// Track page views and clicks for signed-in customers (never for admin
	// "view as user" sessions, which must not look like the customer's activity).
	const tracker = createActivityTracker();
	afterNavigate((nav) => tracker.onNavigate(nav));
	$: tracker.setEnabled(!!data.user && !data.readOnly);
	onDestroy(() => tracker.setEnabled(false));
</script>

<div class="ro-root" use:readOnlyGuard={data.readOnly}>
	<slot />
</div>

{#if data.readOnly}
	<div class="ro-banner" role="status">
		<span><strong>Read-only view</strong> — you're viewing as {data.user?.email}{data.impersonatedBy ? ` (started by ${data.impersonatedBy})` : ''}. Nothing can be changed.</span>
		<form method="POST" action="/auth/impersonation-exit"><button type="submit">Exit &amp; return to admin</button></form>
	</div>
{/if}

<style>
	.ro-root { display: contents; }
	:global(.ro-disabled) { opacity: .5; pointer-events: none; cursor: not-allowed; }
	:global([data-ro-locked]) { cursor: not-allowed !important; opacity: .55; }
	.ro-banner {
		position: fixed; bottom: 14px; left: 50%; transform: translateX(-50%); z-index: 3000;
		display: flex; align-items: center; gap: 14px; max-width: calc(100vw - 32px);
		background: #1B2B4B; color: #fff; padding: 10px 16px; border-radius: 10px;
		font-size: 13px; box-shadow: 0 8px 30px rgba(0,0,0,.3); border: 2px solid #F5A100;
	}
	.ro-banner button {
		background: #F5A100; color: #fff; border: none; border-radius: 7px; padding: 6px 12px;
		font-weight: 700; font-size: 12px; cursor: pointer; white-space: nowrap;
	}
</style>
