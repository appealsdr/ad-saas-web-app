<script lang="ts">
	import Topbar from '$components/layout/Topbar.svelte';
	import type { PageData } from './$types';
	export let data: PageData;
	$: c = data.contract;
	const money = (n: number) => { try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c.currency }).format(n); } catch { return `$${n.toFixed(2)}`; } };
</script>

<svelte:head><title>{c.name} — Appeals Doctor</title></svelte:head>
<Topbar title="Service contract" subtitle={c.name} />

<div class="content-area">
	<a class="back" href="/dashboard">← Back to dashboard</a>

	<div class="card">
		<h1>{c.name}</h1>
		<div class="meta">
			{#if c.number}<span>Contract {c.number}</span>{/if}
			{#if c.storeName}<span>Store: {c.storeName}</span>{/if}
			{#if c.startDate}<span>{c.startDate}{c.endDate ? ` → ${c.endDate}` : ''}</span>{/if}
		</div>
		<div class="sums">
			<div><small>Contract total</small><strong>{money(c.totals.contract)}</strong></div>
			<div><small>Paid</small><strong>{money(c.totals.paid)}</strong></div>
			<div class="due"><small>Outstanding</small><strong>{money(c.totals.due)}</strong></div>
		</div>
	</div>

	<div class="card">
		<h2>What's included</h2>
		{#if c.lines.length === 0}<p class="muted">No services on this contract yet.</p>{/if}
		{#each c.lines as l (l.id)}
			<div class="row">
				<div class="grow">
					<div class="strong">{l.name}</div>
					{#if l.description}<div class="muted">{l.description}</div>{/if}
					{#if l.deposit != null}<div class="muted">Deposit {money(l.deposit)} · balance {money(Math.max(0, l.total - l.deposit))}</div>{/if}
				</div>
				<div class="muted">{l.quantity} × {money(l.unitPrice)}</div>
				<div class="strong">{money(l.total)}</div>
			</div>
		{/each}
	</div>

	<div class="card">
		<h2>Payments</h2>
		{#each c.payments as p (p.id)}
			<div class="row">
				<div class="grow">
					<div class="strong">{p.description ?? p.type ?? p.name}</div>
					<div class="muted">{p.name}{p.date ? ` · ${p.date}` : ''}</div>
				</div>
				<div class="strong">{money(p.amount)}</div>
				{#if p.payable}
					<a class="btn btn-primary btn-sm" href={`/payments/pay/${p.id}`}>Pay</a>
				{:else}
					<span class="badge {p.status === 'Paid' ? 'badge-green' : 'badge-grey'}">{p.status === 'Not Active' ? 'Not active yet' : p.status}</span>
				{/if}
			</div>
		{/each}
	</div>
</div>

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
	.card { background: white; border: 1px solid var(--grey-line); border-radius: 16px; padding: 22px 26px; }
	.back { font-size: 13px; color: var(--grey-text); text-decoration: none; }
	h1 { font-size: 22px; font-weight: 800; color: var(--navy); margin: 0 0 6px; }
	h2 { font-size: 15px; font-weight: 700; color: var(--navy); margin: 0 0 10px; }
	.meta { display: flex; gap: 16px; flex-wrap: wrap; font-size: 13px; color: var(--grey-text); margin-bottom: 14px; }
	.sums { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
	.sums small { display: block; color: var(--grey-text); font-size: 12px; }
	.sums strong { font-size: 18px; color: var(--navy); }
	.sums .due strong { color: var(--orange); }
	.row { display: flex; align-items: center; gap: 14px; padding: 10px 0; border-top: 1px solid var(--grey-line); font-size: 14px; }
	.row:first-of-type { border-top: none; }
	.grow { flex: 1; min-width: 0; }
	.strong { font-weight: 700; }
	.muted { color: var(--grey-text); font-size: 12px; }
</style>
