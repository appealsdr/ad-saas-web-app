<script lang="ts">
	import { navigating, page } from '$app/stores';
	import type { LayoutData } from './$types';
	export let data: LayoutData;
	$: base = `/admin/accounts/${data.account.id}`;
	$: q = data.from ? `?from=${encodeURIComponent(data.from)}` : '';
	const tabs: [string, string][] = [
		['', 'Overview'], ['/users', 'Users'], ['/stores', 'Stores'], ['/cases', 'Cases'],
		['/billing', 'Billing'], ['/documents', 'Documents'], ['/integrations', 'Integrations'], ['/activity', 'App activity'], ['/logs', 'Logs'], ['/data', 'Data']
	];
	// Use the destination while navigating so the clicked tab is active immediately.
	const RECORD_TAB: Record<string, string> = { store: '/stores', user: '/users', contract: '/billing' };
	$: rawPath = ($navigating?.to?.url.pathname ?? $page.url.pathname).replace(/\/$/, '');
	// A record page (…/records/store/<id>) belongs to its list tab.
	$: path = rawPath.replace(new RegExp('^(' + base + ')/records/([a-z]+)/.*$'), (_m, b: string, k: string) => b + (RECORD_TAB[k] ?? ''));
	$: cur = (suffix: string) => (path === base + suffix || (suffix !== '' && path.startsWith(base + suffix + '/')) ? 'page' : undefined);
	$: section = tabs.find(([s]) => cur(s))?.[1] ?? 'Overview';
	const SF = {
		synced: ['Synced', '#DCFCE7', '#15803d', 'This record exists in Salesforce.'],
		not_in_sf: ['Not in Salesforce', '#FEE2E2', '#b91c1c', 'This account is not (or no longer) in Salesforce.'],
		unknown: ['Unknown', '#FEF3C7', '#92400e', 'Salesforce could not be reached, so the sync state is unknown.']
	} as const;
	$: sf = SF[data.sfState];
	$: statLinks = [
		{ label: 'Users', value: data.stats.users, to: '/users', ok: false },
		{ label: 'Stores', value: data.stats.stores, to: '/stores', ok: false },
		{ label: 'SP-API connected', value: data.stats.connectedStores, to: '/integrations', ok: true },
		{ label: 'Contracts', value: data.stats.contracts, to: '/billing/contracts', ok: false }
	];
	let copied = false;
	async function copyId() {
		try { await navigator.clipboard.writeText(data.account.id); copied = true; setTimeout(() => (copied = false), 1500); } catch { /* needs user gesture */ }
	}
</script>

<nav class="crumbs" aria-label="Breadcrumb">
	<a href={data.backHref}>Accounts</a><span>/</span><span>{data.account.name}</span><span>/</span><span class="cur">{section}</span>
</nav>

<section class="hero">
	<div class="hero-top">
		<div class="hero-main">
			<div class="titlerow"><h1>{data.account.name}</h1><span class="chip" style="background:{sf[1]};color:{sf[2]}" title={sf[3]}>SF · {sf[0]}</span></div>
			<div class="hero-sub">
				<span>Account</span>
				<button type="button" class="idbtn" title="Click to copy" on:click={copyId}>{copied ? 'Copied ✓' : data.account.id}</button>
				{#if data.account.email}<span>· {data.account.email}</span>{/if}
			</div>
		</div>
		<div class="stats">
			{#each statLinks as st}
				<a class="stat" href="{base}{st.to}{q}" title="Open {st.label === 'SP-API connected' ? 'Integrations' : st.label}"><span class="sl">{st.label}</span><span class="sv" class:ok={st.ok}>{st.value}</span></a>
			{/each}
		</div>
		<span class="adm-muted tag">Admin view · acting as yourself, not as a customer</span>
	</div>
	<nav class="tabs" aria-label="Account sections">
		{#each tabs as [suffix, label]}
			<a href="{base}{suffix}{q}" aria-current={cur(suffix)}>{label}</a>
		{/each}
	</nav>
</section>

<!-- key by account so one account's UI state never leaks into another -->
{#key data.account.id}<slot />{/key}

<style>
	.crumbs { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 12px; color: var(--grey-text); margin-bottom: 10px; }
	.crumbs a { color: var(--grey-text); text-decoration: none; }
	.crumbs a:hover { color: var(--navy); text-decoration: underline; }
	.crumbs .cur { color: var(--navy); font-weight: 600; }
	.hero { background: #fff; border: 1px solid var(--grey-line); border-radius: 12px; margin-bottom: 16px; overflow: hidden; }
	.hero-top { padding: 18px 22px; display: flex; gap: 22px; align-items: center; flex-wrap: wrap; }
	.hero-main { flex: 1; min-width: 240px; }
	h1 { margin: 0; font-size: 22px; font-weight: 800; color: var(--navy); }
	.hero-sub { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; font-size: 12px; color: var(--grey-text); }
	.idbtn { background: #F6F8FB; border: 1px solid var(--grey-line); border-radius: 6px; padding: 1px 7px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--navy); cursor: pointer; }
	.idbtn:hover { border-color: var(--navy); }
	.stats { display: flex; gap: 24px; }
	.titlerow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
	.titlerow h1 { margin: 0; }
	.chip { display: inline-block; padding: 2px 10px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
	.stat { display: flex; flex-direction: column; align-items: flex-end; text-decoration: none; background: #F6F8FB; border: 1px solid var(--grey-line); border-radius: 10px; padding: 8px 14px; }
	.stat:hover { border-color: var(--navy); background: #fff; }
	.sl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); }
	.sv { font-size: 22px; font-weight: 800; color: var(--navy); line-height: 1.2; }
	.sv.ok { color: #15803d; }
	.tag { font-size: 11px; flex-basis: 100%; }
	.tabs { display: flex; flex-wrap: wrap; gap: 2px; padding: 0 14px; border-top: 1px solid var(--grey-line); background: #fafbfd; }
	.tabs a { padding: 11px 14px; font-size: 13px; font-weight: 600; color: var(--grey-text); text-decoration: none; border-bottom: 2px solid transparent; margin-bottom: -1px; }
	.tabs a:hover { color: var(--navy); }
	.tabs a[aria-current='page'] { color: var(--navy); border-bottom-color: var(--orange); }
	.tabs a:focus-visible { outline: 3px solid var(--orange); outline-offset: -3px; }
</style>
