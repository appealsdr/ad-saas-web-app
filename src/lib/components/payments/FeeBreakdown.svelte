<script lang="ts">
	import type { FeeBreakdown } from '$lib/payments/fees';
	export let fee: FeeBreakdown;
	export let currency = 'USD';
	export let baseLabel = 'Amount';
	export let updating = false;

	const money = (cents: number) => {
		try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100); } catch { return `$${(cents / 100).toFixed(2)}`; }
	};
</script>

<ul class="fees" class:updating>
	<li><span>{baseLabel}</span><strong>{money(fee.baseCents)}</strong></li>
	<li><span>{fee.label}</span><strong>{money(fee.feeCents)}</strong></li>
	<li class="total"><span>Total charged</span><strong>{money(fee.totalCents)}</strong></li>
</ul>
<p class="note">The processing fee depends on the payment method you choose below.</p>

<style>
	.fees { list-style: none; margin: 16px 0 6px; padding: 0; border: 1px solid var(--grey-line); border-radius: 12px; background: #fafafa; transition: opacity .15s; }
	.fees.updating { opacity: .5; }
	li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--grey-line); }
	li:last-child { border-bottom: none; }
	li.total { font-size: 14px; font-weight: 700; color: var(--navy); }
	strong { font-variant-numeric: tabular-nums; }
	.note { font-size: 12px; color: var(--grey-text); margin: 0 0 14px; }
</style>
