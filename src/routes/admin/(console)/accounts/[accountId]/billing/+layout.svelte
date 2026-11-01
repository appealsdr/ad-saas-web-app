<script lang="ts">
	import { page } from '$app/stores';
	$: base = `/admin/accounts/${$page.params.accountId}/billing`;
	const subs: [string, string][] = [['/contracts', 'Contracts'], ['/payments', 'Payments'], ['/stripe', 'Stripe status']];
	$: isOn = (s: string) => $page.url.pathname === base + s || $page.url.pathname.startsWith(base + s + '/');
</script>

<nav class="subtabs" aria-label="Billing sections">
	{#each subs as [s, label]}<a href="{base}{s}" aria-current={isOn(s) ? 'page' : undefined}>{label}</a>{/each}
</nav>
<slot />

<style>
	.subtabs { display: flex; gap: 6px; margin-bottom: 14px; }
	.subtabs a { padding: 6px 16px; border: 1px solid var(--grey-line); border-radius: 99px; font-size: 13px; font-weight: 700; color: var(--navy); text-decoration: none; background: #fff; }
	.subtabs a:hover { border-color: var(--navy); }
	.subtabs a[aria-current='page'] { background: var(--navy); border-color: var(--navy); color: #fff; }
</style>
