<script lang="ts">
	import type { PageData } from './$types';
	export let data: PageData;

	function formatAmount(amount: number | null, currency: string | null) {
		if (amount == null || !currency) return '';
		try {
			return new Intl.NumberFormat('en-US', {
				style: 'currency',
				currency: currency.toUpperCase()
			}).format(amount / 100);
		} catch {
			return `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`;
		}
	}
</script>

<svelte:head><title>Payment received — Appeals Doctor</title></svelte:head>

<div class="wrap">
	<div class="card">
		{#if data.paymentStatus === 'paid' || data.paymentStatus === 'succeeded'}
			<div class="ok-mark">✓</div>
			<h1>Payment received</h1>
			<p class="sub">Thanks — your order is being processed.</p>
		{:else}
			<div class="pending-mark">…</div>
			<h1>Payment processing</h1>
			<p class="sub">Stripe is still finalizing your payment. You'll see it appear shortly.</p>
		{/if}

		<div class="details">
			{#if data.productName}
				<div class="row">
					<span>Services</span>
					<strong>
						{data.productName}{#if (data.productCount ?? 1) > 1}
							{' '}+ {(data.productCount ?? 1) - 1} more
						{/if}
					</strong>
				</div>
			{/if}
			{#if data.amountTotal != null}
				<div class="row">
					<span>Amount</span>
					<strong>{formatAmount(data.amountTotal, data.currency)}</strong>
				</div>
			{/if}
			{#if data.customerEmail}
				<div class="row"><span>Receipt to</span><strong>{data.customerEmail}</strong></div>
			{/if}
		</div>

		{#if data.contractInfo}
			{#if data.contractInfo.syncStatus === 'synced'}
				<div class="contract-note ok">
					<strong>✓ Following services created</strong>
					{#if data.products?.length}
						<ul class="svc-list">
							{#each data.products as s}<li>{s}</li>{/each}
						</ul>
					{/if}
				</div>
			{:else if data.contractInfo.syncStatus === 'already-exists'}
				<div class="contract-note muted">
					Service Contract was already on file (idempotent confirm).
				</div>
			{:else if data.contractInfo.syncStatus === 'failed'}
				<div class="contract-note warn">
					Payment captured, but Salesforce sync failed:
					<code>{data.contractInfo.syncError ?? 'unknown'}</code>. Our team will reconcile.
				</div>
			{/if}
		{/if}

		<a
			href={data.contractInfo?.localContractId
				? `/payments/${data.contractInfo.localContractId}`
				: '/payments'}
			class="btn btn-primary btn-full"
			style="margin-top:18px"
		>View my Services</a>
		<a href="/stores" class="back-link">← Back to stores</a>
	</div>
</div>

<style>
	.wrap { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
	.card {
		background: white; border-radius: 20px; padding: 32px;
		width: 100%; max-width: 460px; box-shadow: var(--shadow-xl);
	}
	.ok-mark, .pending-mark {
		width: 56px; height: 56px; border-radius: 50%;
		display: grid; place-items: center; margin: 0 auto 16px;
		font-size: 28px; font-weight: 800;
	}
	.ok-mark { background: #d4f7dc; color: #117a37; }
	.pending-mark { background: #fff3d6; color: #8a6500; }
	h1 { font-size: 22px; font-weight: 800; color: var(--navy); margin: 0; text-align: center; }
	.sub { text-align: center; color: var(--grey-text); margin-top: 6px; }
	.details {
		margin-top: 22px; padding-top: 18px; border-top: 1px solid var(--grey-line);
		display: flex; flex-direction: column; gap: 10px;
	}
	.row { display: flex; justify-content: space-between; font-size: 14px; }
	.row span { color: var(--grey-text); }

	.contract-note {
		margin-top: 16px; padding: 10px 14px;
		border-radius: 9px; font-size: 12px;
	}
	.contract-note.ok { background: #d1fae5; color: #047857; border: 1px solid #86efac; }
	.svc-list { margin: 8px 0 0; padding-left: 20px; text-align: left; }
	.svc-list li { margin: 2px 0; }
	.contract-note.muted { background: #f3f4f6; color: var(--grey-text); border: 1px solid var(--grey-line); }
	.contract-note.warn { background: #fef3c7; color: #92400e; border: 1px solid #fcd34d; }
	.contract-note code {
		font-family: ui-monospace, monospace; font-size: 11px;
		background: rgba(0,0,0,.05); padding: 1px 4px; border-radius: 3px;
	}
	.back-link {
		display: block; text-align: center; margin-top: 12px;
		font-size: 13px; color: var(--grey-text); text-decoration: none;
	}
	.back-link:hover { color: var(--navy); }
</style>
