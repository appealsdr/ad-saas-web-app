<script lang="ts">
	import { page } from '$app/stores';
	import RowMenu from '$lib/components/admin/RowMenu.svelte';
	import type { PageData } from './$types';
	export let data: PageData;

	type P = PageData['payments'][number];
	const FILTERS = [['all', 'All'], ['paid', 'Paid'], ['due', 'Due'], ['ready', 'Ready to pay'], ['inactive', 'Not Active'], ['failed', 'Failed'], ['closed', 'Closed']] as const;
	let filter: (typeof FILTERS)[number][0] = 'all';
	let search = '';
	const matches = (p: P, f: string) => f === 'all' || p.status === f;
	$: count = (f: string) => data.payments.filter((p) => matches(p, f)).length;
	$: list = data.payments.filter((p) => {
		const q = search.trim().toLowerCase();
		return matches(p, filter) && (!q || [p.name, p.contractRef, p.storeName, p.kind, p.stripePi, p.sfId].join(' ').toLowerCase().includes(q));
	});
	$: base = `/admin/accounts/${$page.params.accountId}`;
	$: totalPaid = data.payments.filter((p) => !p.isLine && p.status === 'paid').reduce((n, p) => n + p.amount, 0);
	const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const fmtD = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
	const PAY = { paid: ['Paid', '#DCFCE7', '#15803d'], due: ['Due', '#FEF3C7', '#92400e'], failed: ['Failed', '#FEE2E2', '#b91c1c'], closed: ['Closed', '#F1F5F9', '#475569'], inactive: ['Not Active', '#F1F5F9', '#475569'], ready: ['Ready to pay', '#DBEAFE', '#1d4ed8'] } as const;
	const menu = (p: P) => [
		{ label: 'View', icon: '👁', href: `${base}/billing/payments/${encodeURIComponent(p.key)}` },
		{ label: 'View in Salesforce', icon: '↗', href: p.sfUrl ?? undefined, disabled: !p.sfUrl, title: p.sfUrl ? undefined : 'No Salesforce payment record' },
		{ label: 'View in Stripe', icon: '↗', href: p.stripeUrl ?? undefined, disabled: !p.stripeUrl, title: p.stripeUrl ? undefined : 'No Stripe reference' }
	];
</script>

<svelte:head><title>Payments — Admin</title></svelte:head>
{#if data.paymentsError}<div class="adm-alert warn">Payments could not be loaded from Salesforce ({data.paymentsError}); the Stripe charge is shown instead.</div>{/if}
<div class="adm-alert info"><span aria-hidden="true">ℹ</span> Payments are read from Salesforce (First Payment plus one per line for deposit services). Contracts without Salesforce payments show the original Stripe charge. Line payments are components of the First Payment and aren't counted twice in totals.</div>

<div class="adm-card">
	<div class="toolbar">
		<input type="search" class="adm-input search" placeholder="Search payments by number, contract, store, type, Stripe or Salesforce ID…" aria-label="Search payments" bind:value={search} />
		{#if search}<button type="button" class="adm-btn outline sm" on:click={() => (search = '')}>Clear</button>{/if}
	</div>
	<div class="pillbar">
		{#each FILTERS as [k, label]}<button type="button" class="pill" class:active={filter === k} on:click={() => (filter = k)}>{label} <span>{count(k)}</span></button>{/each}
		<span class="adm-muted foot">Showing {list.length} of {data.payments.length} payments · {money(totalPaid)} paid to date</span>
	</div>
	{#if list.length === 0}
		<div class="adm-empty">{data.payments.length === 0 ? 'This account has no payments.' : 'No payments match these filters.'}</div>
	{:else}
		<div class="adm-table-wrap"><table class="adm-table">
			<caption class="adm-sr">Payments</caption>
			<thead><tr><th scope="col">Payment</th><th scope="col">Contract</th><th scope="col">Store</th><th scope="col">Type</th><th scope="col">Amount</th><th scope="col">Date</th><th scope="col">Status</th><th scope="col">Stripe</th><th scope="col">Record</th></tr></thead>
			<tbody>
				{#each list as p (p.key)}
					{@const st = PAY[p.status]}
					<tr>
						<td><a class="adm-mono" href="{base}/billing/payments/{encodeURIComponent(p.key)}" title="Open payment">{p.name}</a>{#if p.sfId}<div class="adm-mono adm-muted">{p.sfId}</div>{/if}</td>
						<td><a class="adm-mono" href="{base}/records/contract/{p.contractId}">{p.contractRef}</a></td>
						<td>{p.storeName ?? '—'}</td>
						<td>{p.kind}</td>
						<td><strong>{money(p.amount)}</strong></td>
						<td>{fmtD(p.date)}</td>
						<td><span class="chip" style="background:{st[1]};color:{st[2]}">{st[0]}</span></td>
						<td class="adm-mono adm-muted">{p.stripePi ?? '—'}</td>
						<td><RowMenu items={menu(p)} /></td>
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
