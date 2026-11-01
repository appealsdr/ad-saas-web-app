<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	let busy = false;
	const money = (c: string | null, cur: string | null) => (c == null ? '—' : `${(Number(c) / 100).toFixed(2)} ${(cur ?? '').toUpperCase()}`);
	const d = (v: Date | string | null) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
</script>

<svelte:head><title>Billing — Admin</title></svelte:head>
<div class="adm-card">
	<h2>Payments &amp; subscriptions (local records)</h2>
	{#if data.contracts.length === 0}<div class="adm-empty">No payments or subscriptions.</div>{:else}
		<div class="adm-table-wrap"><table class="adm-table">
			<caption class="adm-sr">Local billing records</caption>
			<thead><tr><th scope="col">Type</th><th scope="col">Amount</th><th scope="col">Local status</th><th scope="col">Paid</th><th scope="col">Stripe refs</th></tr></thead>
			<tbody>
				{#each data.contracts as c (c.id)}
					<tr>
						<td>{c.kind ?? 'unknown'}</td><td>{money(c.amount_cents, c.currency)}</td>
						<td>{c.status ?? 'unknown'} / {c.payment_status ?? 'unknown'}</td><td>{d(c.paid_at)}</td>
						<td class="adm-mono">{c.stripe_subscription_id ?? c.stripe_payment_intent_id ?? '—'}</td>
					</tr>
				{/each}
			</tbody></table></div>
	{/if}
</div>
<div class="adm-card">
	<h2>Authoritative status from Stripe</h2>
	<p class="adm-muted">Local statuses above are copies. Fetch the provider’s current subscription state on demand.</p>
	{#if data.stripeCustomerId}
		<form method="POST" action="?/stripe" use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update({ reset: false }); }; }}>
			<button class="adm-btn" type="submit" disabled={busy}>{busy ? 'Contacting Stripe…' : 'Fetch from Stripe'}</button>
		</form>
	{:else}<p class="adm-null">No Stripe customer linked to this account.</p>{/if}
	{#if form && 'stripe' in form && form.stripe}
		{@const s = form.stripe}
		<p class="adm-muted">Source: {s.source} · fetched {s.fetchedAt}</p>
		{#if s.ok}<pre class="adm-pre">{JSON.stringify(s.data, null, 2)}</pre>{:else}<div class="adm-alert error">Stripe unavailable: {s.error}</div>{/if}
	{/if}
</div>
