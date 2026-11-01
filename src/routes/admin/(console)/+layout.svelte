<script lang="ts">
	import { navigating, page } from '$app/stores';
	import type { LayoutData } from './$types';
	export let data: LayoutData;
	$: path = $navigating?.to?.url.pathname ?? $page.url.pathname;
	$: cur = (p: string) => (path === p || path.startsWith(p + '/') ? 'page' : undefined);
</script>

<div class="adm-shell">
	<a href="#adm-main" class="adm-sr">Skip to content</a>
	<header class="adm-top">
		<span class="adm-brand">Appeals Doctor · Admin</span>
		<nav aria-label="Admin" style="display:flex;gap:20px">
			<a href="/admin/accounts" aria-current={cur('/admin/accounts')}>Accounts</a>
			<a href="/admin/users" aria-current={cur('/admin/users')}>Users</a>
			{#if data.can.logs}<a href="/admin/logs" aria-current={cur('/admin/logs')}>Logs</a>{/if}
			{#if data.can.data}<a href="/admin/data" aria-current={cur('/admin/data')}>Data &amp; SQL</a>{/if}
			{#if data.can.staff}<a href="/admin/staff" aria-current={cur('/admin/staff')}>Staff</a>{/if}
		</nav>
		<span class="adm-spacer"></span>
		<span class="adm-who">{data.staff.email} · {data.staff.role === 'platform_admin' ? 'Admin' : 'Viewer'}</span>
		<form method="POST" action="/admin/logout"><button class="adm-btn outline sm" type="submit">Sign out</button></form>
	</header>
	<main id="adm-main" class="adm-main"><slot /></main>
</div>
