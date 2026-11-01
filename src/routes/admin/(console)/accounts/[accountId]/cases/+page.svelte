<script lang="ts">
	import { page } from '$app/stores';
	import RowMenu from '$lib/components/admin/RowMenu.svelte';
	import type { PageData } from './$types';
	export let data: PageData;

	type C = PageData['cases'][number];
	const FILTERS = [['all', 'All'], ['open', 'Open'], ['waiting', 'Waiting'], ['closed', 'Closed']] as const;
	let filter: (typeof FILTERS)[number][0] = 'all';
	let search = '';
	const isOpen = (s: string) => !/closed|resolved/i.test(s);
	const isWaiting = (s: string) => /waiting|pending|awaiting/i.test(s);
	const matches = (c: C, f: string) => f === 'all' || (f === 'open' ? isOpen(c.status) : f === 'waiting' ? isWaiting(c.status) : !isOpen(c.status));
	$: count = (f: string) => data.cases.filter((c) => matches(c, f)).length;
	$: list = data.cases.filter((c) => {
		const q = search.trim().toLowerCase();
		return matches(c, filter) && (!q || [c.number, c.service, c.subject, c.storeName, c.status, c.priority].join(' ').toLowerCase().includes(q));
	});
	$: base = `/admin/accounts/${$page.params.accountId}`;
	const fmtD = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	const chip = (s: string): [string, string] => (!isOpen(s) ? ['#DCFCE7', '#15803d'] : isWaiting(s) ? ['#FEE2E2', '#b91c1c'] : /progress|working/i.test(s) ? ['#DBEAFE', '#1d4ed8'] : ['#FFEDD5', '#c2410c']);
	const menu = (c: C) => [
		{ label: 'View', icon: '👁', href: `${base}/cases/${c.id}` },
		{ label: 'View in Salesforce', icon: '↗', href: c.sfUrl ?? undefined, disabled: !c.sfUrl, title: c.sfUrl ? undefined : 'Salesforce link unavailable' }
	];
</script>

<svelte:head><title>Cases — Admin</title></svelte:head>
<div class="adm-alert info"><span aria-hidden="true">ℹ</span> Cases are owned by Salesforce and read live for every store of this account that is linked to Salesforce.{#if data.unlinkedStores} {data.unlinkedStores} store{data.unlinkedStores === 1 ? ' is' : 's are'} not linked, so their cases can't be shown.{/if}</div>
{#if data.error}<div class="adm-alert error">Could not load cases from Salesforce: {data.error}</div>{/if}

<div class="adm-card">
	<div class="toolbar">
		<input type="search" class="adm-input search" placeholder="Search cases by number, service, store, status or priority…" aria-label="Search cases" bind:value={search} />
		{#if search}<button type="button" class="adm-btn outline sm" on:click={() => (search = '')}>Clear</button>{/if}
	</div>
	<div class="pillbar">
		{#each FILTERS as [k, label]}<button type="button" class="pill" class:active={filter === k} on:click={() => (filter = k)}>{label} <span>{count(k)}</span></button>{/each}
		<span class="adm-muted foot">Showing {list.length} of {data.cases.length} cases</span>
	</div>
	{#if list.length === 0}
		<div class="adm-empty">{data.cases.length === 0 ? 'No cases for this account.' : 'No cases match these filters.'}</div>
	{:else}
		<div class="adm-table-wrap"><table class="adm-table">
			<caption class="adm-sr">Cases</caption>
			<thead><tr><th scope="col">Case</th><th scope="col">Service</th><th scope="col">Store</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Opened</th><th scope="col">Updated</th><th scope="col">Record</th></tr></thead>
			<tbody>
				{#each list as c (c.id)}
					{@const ch = chip(c.status)}
					<tr>
						<td><a class="adm-mono" href="{base}/cases/{c.id}" title="Open case">{c.number}</a><br /><span class="adm-mono adm-muted">{c.id}</span></td>
						<td>{c.service}{#if c.subject && c.subject !== c.service}<div class="adm-muted">{c.subject}</div>{/if}</td>
						<td>{#if c.storeId}<a href="{base}/records/store/{c.storeId}">{c.storeName}</a>{:else}{c.storeName}{/if}</td>
						<td><span class="chip" style="background:{ch[0]};color:{ch[1]}">{c.status}</span></td>
						<td>{c.priority ?? '—'}</td><td>{fmtD(c.opened)}</td><td>{fmtD(c.modified)}</td>
						<td><RowMenu items={menu(c)} /></td>
					</tr>
				{/each}
			</tbody>
		</table></div>
	{/if}
</div>

<style>
	.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
	.search { flex: 1; }
	.pillbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
	.pill { background: #fff; border: 1px solid var(--grey-line); border-radius: 99px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer; }
	.pill.active { background: var(--navy); border-color: var(--navy); color: #fff; }
	.pill span { opacity: .7; margin-left: 3px; }
	.foot { margin-left: auto; font-size: 12px; }
	.chip { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
</style>
