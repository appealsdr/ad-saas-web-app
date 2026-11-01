<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type { PageData } from './$types';

	export let data: PageData;

	let busy = false;

	function continueToPayment() {
		if (data.items.length === 0 || busy) return;
		busy = true;
		// Pass the whole query string through unchanged — `store=<id>` came in
		// from /stores/<id>/services and is the store the contract attaches to.
		goto(`/checkout/payment?${$page.url.searchParams.toString()}`);
	}

	function formatPrice(amount: number, c: string) {
		try {
			return new Intl.NumberFormat('en-US', {
				style: 'currency', currency: c
			}).format(amount);
		} catch {
			return `$${amount.toFixed(2)} ${c}`;
		}
	}
</script>

<svelte:head><title>Order summary — Appeals Doctor</title></svelte:head>

<div class="wrap">
	<div class="card">
		<header>
			{#if data.selectedStore}
				<a class="back-link" href={`/stores/${data.selectedStore.id}/services`}>← Back to services</a>
			{:else}
				<a class="back-link" href="/stores">← Back to stores</a>
			{/if}
			<h1>Order summary</h1>
			<p class="sub">Review your selection before paying.</p>
		</header>

		{#if data.missing.length > 0}
			<div class="alert alert-error" style="margin-bottom:16px">
				{data.missing.length} item{data.missing.length === 1 ? '' : 's'} from your selection
				{data.missing.length === 1 ? 'is' : 'are'} no longer available and {data.missing.length === 1 ? 'has' : 'have'}
				been removed.
			</div>
		{/if}

		{#if data.items.length === 0}
			<div class="alert alert-error">None of the selected services are still available.</div>
			<a class="btn btn-primary btn-full"
				href={data.selectedStore ? `/stores/${data.selectedStore.id}/services` : '/stores'}
				style="margin-top:14px">Back to services</a>
		{:else}
			<table class="summary-table">
				<thead>
					<tr>
						<th>Service</th>
						<th>Category</th>
						<th class="center">Qty</th>
						<th class="right">Price</th>
					</tr>
				</thead>
				<tbody>
					{#each data.items as item}
						<tr>
							<td>
								<div class="svc-name">{item.name}</div>
								{#if item.description}
									<div class="svc-desc">{item.description}</div>
								{/if}
								{#if item.quantity > 1}
									<div class="svc-note">Opens {item.quantity} separate cases — one per unit.</div>
								{/if}
							</td>
							<td>{item.category ?? '—'}</td>
							<td class="center">{item.quantity}</td>
							<td class="right">
								{formatPrice(item.lineTotal, item.currency)}
								{#if item.paymentType === 'Deposit' && item.depositAmount != null}
									<div class="dep-note"><strong>{formatPrice(item.depositAmount * item.quantity, item.currency)}</strong> deposit now</div>
									<div class="dep-sub">{formatPrice(item.lineTotal - item.depositAmount * item.quantity, item.currency)} balance later</div>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<td colspan="3" class="total-label">{data.split ? 'Order total' : 'Total'}</td>
						<td class="right total-amount">{formatPrice(data.total, data.currency)}</td>
					</tr>
					{#if data.split}
						<tr>
							<td colspan="3" class="total-label">Charged now</td>
							<td class="right total-amount">{formatPrice(data.dueFirst, data.currency)}</td>
						</tr>
					{/if}
				</tfoot>
			</table>

			{#if data.split}
				<div class="split-banner" role="note">
					<strong>This order is paid in several payments.</strong>
					You pay <strong>{formatPrice(data.dueFirst, data.currency)}</strong> today: full price for standard services plus the deposit for the others.
					The remaining <strong>{formatPrice(data.dueLater, data.currency)}</strong> is <strong>not charged today</strong> — it is billed as separate payments when each case is completed.
					Every payment appears on your <a href="/payments">Payments</a> screen with its own status.
				</div>
			{/if}

			{#if data.selectedStore}
				<div class="for-store">
					Service contract will be created for store:
					<a href={`/stores/${data.selectedStore.id}`}>
						<strong>{data.selectedStore.name}</strong>
					</a>
					{#if !data.selectedStore.sfdcStoreId}
						<span class="hint"> (this store isn't linked to Salesforce yet — Store__c will be left blank)</span>
					{/if}
					<p class="for-store-note">
						A case will be created automatically for each service you purchase, and our
						technician team will reach out to you as soon as possible to get started.
					</p>
				</div>
			{:else}
				<div class="alert alert-warn" style="margin-top:14px">
					Couldn't identify which store this purchase is for. Go back and start from a store
					page (<a href="/stores">view stores</a>).
				</div>
			{/if}

			<div class="actions">
				{#if data.selectedStore}
					<a class="btn btn-outline" href={`/stores/${data.selectedStore.id}/services`}>Edit selection</a>
				{:else}
					<a class="btn btn-outline" href="/stores">All stores</a>
				{/if}
				<button class="btn btn-primary" data-mutates disabled={busy || !data.selectedStore} on:click={continueToPayment}>
					{busy ? 'Loading…' : 'Continue to payment →'}
				</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.wrap { min-height: 100vh; display: grid; place-items: center; padding: 32px 20px; background: #f7f7f9; }
	.card {
		background: white; border-radius: 20px; padding: 32px;
		width: 100%; max-width: 720px; box-shadow: var(--shadow-xl);
	}
	header { margin-bottom: 22px; }
	.back-link {
		font-size: 13px; color: var(--grey-text); text-decoration: none;
		display: inline-block; margin-bottom: 8px;
	}
	.back-link:hover { color: var(--navy); }
	h1 { font-size: 24px; font-weight: 800; color: var(--navy); margin: 0; }
	.sub { color: var(--grey-text); margin-top: 4px; }

	.summary-table { width: 100%; border-collapse: collapse; font-size: 14px; }
	.summary-table thead th {
		text-align: left; padding: 10px 12px; font-size: 11px;
		text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text);
		font-weight: 700; border-bottom: 1px solid var(--grey-line);
	}
	.summary-table tbody td {
		padding: 14px 12px; border-bottom: 1px solid var(--grey-line); vertical-align: top;
	}
	.svc-name { font-weight: 600; color: var(--navy); }
	.svc-desc { font-size: 12px; color: var(--grey-text); margin-top: 3px; }
	.svc-note { font-size: 11px; color: var(--orange); margin-top: 4px; font-weight: 600; }
	.center { text-align: center; font-variant-numeric: tabular-nums; }
	.right { text-align: right; font-variant-numeric: tabular-nums; }
	.summary-table tfoot td { padding: 16px 12px; font-weight: 700; }
	.dep-note { font-size: 12px; font-weight: 600; color: var(--navy); margin-top: 3px; }
	.dep-sub { font-size: 11px; color: var(--grey-text); }
	.split-banner { background: var(--orange-lt); border: 1px solid var(--orange); border-radius: var(--radius); padding: 12px 16px; margin-top: 14px; font-size: 13px; color: var(--navy); line-height: 1.5; }
	.total-label { text-align: right; color: var(--grey-text); text-transform: uppercase; font-size: 12px; }
	.total-amount { font-size: 20px; color: var(--navy); }

	.actions {
		display: flex; justify-content: space-between; gap: 12px; margin-top: 20px;
	}

	.for-store {
		margin-top: 18px; padding: 12px 14px;
		background: #fff7eb; border: 1px solid #f6d49b;
		border-radius: 10px; font-size: 13px; color: var(--navy);
	}
	.for-store a { color: var(--orange); text-decoration: none; }
	.for-store a:hover { text-decoration: underline; }
	.for-store .hint { color: var(--grey-text); }
	.for-store-note {
		margin: 10px 0 0;
		padding: 10px 12px;
		background: var(--orange-lt, #fff4dc);
		border-radius: 8px;
		color: var(--navy);
		font-size: 13px;
		line-height: 1.45;
	}
	.alert-warn {
		background: #fef3c7; border: 1px solid #fcd34d; color: #92400e;
		padding: 12px 16px; border-radius: 9px; font-size: 13px;
	}
	.alert-warn a { color: #92400e; font-weight: 600; }
</style>
