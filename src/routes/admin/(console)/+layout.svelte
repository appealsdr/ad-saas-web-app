<script lang="ts">
	import { navigating, page } from '$app/stores';
	import { provideAdminTime } from '$lib/admin/tz';
	import { resolveTimeZone } from '$lib/admin/time';
	import type { LayoutData } from './$types';
	export let data: LayoutData;
	const savedTz = provideAdminTime(data.staff.timeZone);
	$: savedTz.set(data.staff.timeZone);
	$: zone = resolveTimeZone(data.staff.timeZone);
	$: path = $navigating?.to?.url.pathname ?? $page.url.pathname;
	$: cur = (p: string) => (path === p || path.startsWith(p + '/') ? 'page' : undefined);
</script>

<div class="adm-shell">
	<a href="#adm-main" class="adm-sr">Skip to content</a>
	<header class="adm-top">
		<span class="adm-brand">Appeals Doctor · Admin</span>
		<nav aria-label="Admin" style="display:flex;gap:20px">
			{#if data.can.logs}<a href="/admin/dashboard" aria-current={cur('/admin/dashboard')}>Dashboard</a>{/if}
			<a href="/admin/accounts" aria-current={cur('/admin/accounts')}>Accounts</a>
			<a href="/admin/users" aria-current={cur('/admin/users')}>Users</a>
			{#if data.can.logs}<a href="/admin/logs" aria-current={cur('/admin/logs')}>Logs</a>{/if}
			{#if data.can.data}<a href="/admin/data" aria-current={cur('/admin/data')}>Data &amp; SQL</a>{/if}
			<a href="/admin/api-integrations" aria-current={cur('/admin/api-integrations')}>API</a>
			{#if data.can.logs}<a href="/admin/security" aria-current={cur('/admin/security')}>Security</a>{/if}
			{#if data.can.staff}<a href="/admin/staff" aria-current={cur('/admin/staff')}>Staff</a>{/if}
		</nav>
		<span class="adm-spacer"></span>
		<a class="adm-who" href="/admin/time-zone" title="Change your display time zone" aria-current={cur('/admin/time-zone')}>🕒 {zone}</a>
		<span class="adm-who">{data.staff.email} · {data.staff.role === 'platform_admin' ? 'Admin' : 'Viewer'}</span>
		<form method="POST" action="/admin/logout"><button class="adm-btn outline sm" type="submit">Sign out</button></form>
	</header>
	<main id="adm-main" class="adm-main"><slot /></main>
</div>
