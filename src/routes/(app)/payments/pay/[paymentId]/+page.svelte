<script lang="ts">
	import { onMount } from 'svelte';
	import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';
	import { Elements, PaymentElement } from 'svelte-stripe';
	import { env } from '$env/dynamic/public';
	import Topbar from '$components/layout/Topbar.svelte';
	import FeeBreakdownView from '$lib/components/payments/FeeBreakdown.svelte';
	import type { FeeBreakdown } from '$lib/payments/fees';
	import type { PageData } from './$types';

	export let data: PageData;
	const PUBLIC_STRIPE_KEY = env.PUBLIC_STRIPE_KEY ?? '';

	let stripe: Stripe | null = null;
	let clientSecret = '';
	let initError: string | null = null;
	let formError: string | null = null;
	let submitting = false;
	let elements: StripeElements | undefined;
	let intentId = '';
	// Starts at the server-computed card fee; replaced by the server's figure when the client picks another method.
	let fee: FeeBreakdown = { method: 'card', label: 'Card processing fee (charged by Stripe)', baseCents: Math.round(data.amount * 100), feeCents: Math.round(data.fee * 100), totalCents: Math.round((data.amount + data.fee) * 100) };
	let feeUpdating = false;
	let lastMethod = '';

	// The client changed payment method -> ask the server to re-price the PaymentIntent with that method's fee.
	async function onMethodChange(e: { value?: { type?: string } }) {
		const type = e.value?.type;
		// The first event (default method) also syncs us with the server's figure, e.g. after a reload.
		if (!type || type === lastMethod || !intentId) return;
		lastMethod = type;
		feeUpdating = true;
		try {
			const res = await fetch(`/api/payments/${encodeURIComponent(data.paymentId)}/fee`, {
				method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ intentId, method: type })
			});
			if (!res.ok) throw new Error();
			fee = ((await res.json()) as { fee: FeeBreakdown }).fee;
			await elements?.fetchUpdates();
			formError = null;
		} catch {
			formError = 'Could not update the processing fee. Please re-select your payment method.';
		} finally {
			feeUpdating = false;
		}
	}

	const money = (n: number, c: string) => {
		try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(n); } catch { return `$${n.toFixed(2)} ${c}`; }
	};

	onMount(async () => {
		if (!data.payable) return;
		try {
			if (!PUBLIC_STRIPE_KEY) throw new Error('Payments are not configured (PUBLIC_STRIPE_KEY).');
			stripe = await loadStripe(PUBLIC_STRIPE_KEY);
			if (!stripe) throw new Error('Stripe failed to load.');
			const res = await fetch(`/api/payments/${encodeURIComponent(data.paymentId)}/intent`, { method: 'POST' });
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || 'Could not start the payment.');
			const body = (await res.json()) as { clientSecret: string; intentId: string; fee: FeeBreakdown };
			intentId = body.intentId;
			fee = body.fee;
			clientSecret = body.clientSecret;
		} catch (e) {
			initError = e instanceof Error ? e.message : 'Could not start the payment.';
		}
	});

	async function submit() {
		if (!stripe || !elements || submitting) return;
		formError = null;
		submitting = true;
		const result = await stripe.confirmPayment({
			elements,
			confirmParams: { return_url: `${window.location.origin}/payments/pay/${encodeURIComponent(data.paymentId)}/complete` }
		});
		if (result.error) formError = result.error.message ?? 'Payment failed. Please try again.';
		submitting = false;
	}
</script>

<svelte:head><title>Pay {data.name} — Appeals Doctor</title></svelte:head>
<Topbar title="Pay balance" subtitle={data.name} />

<div class="content-area">
	<div class="card">
		<a class="back" href="/payments">← Back to Payments</a>
		<h1>{money(fee.totalCents / 100, data.currency)}</h1>
		<p class="desc">{data.description}</p>
		{#if data.fee > 0 && !data.paid && !clientSecret}
			<p class="desc">{money(data.amount, data.currency)} balance + {money(data.fee, data.currency)} card processing fee (charged by Stripe)</p>
		{/if}
		<p class="desc"><a href={`/payments?contract=${data.contractId}`}>View full contract details →</a></p>

		{#if data.paid}
			<div class="alert alert-info">This payment has already been paid. Thank you.</div>
		{:else if !data.payable}
			<div class="alert alert-warn">This payment isn't ready to be paid yet. It becomes payable when its case is completed or a payment is requested — we'll let you know.</div>
		{:else if initError}
			<div class="alert alert-error">{initError}</div>
		{:else if clientSecret && stripe}
			<Elements {stripe} {clientSecret} bind:elements>
				<form on:submit|preventDefault={submit}>
					<FeeBreakdownView {fee} currency={data.currency} baseLabel="Balance" updating={feeUpdating} />
					<PaymentElement onchange={onMethodChange} />
					{#if formError}<div class="alert alert-error" style="margin-top:14px">{formError}</div>{/if}
					<button class="btn btn-primary btn-full" type="submit" style="margin-top:18px" disabled={submitting || feeUpdating || !elements}>
						{submitting ? 'Processing…' : `Pay ${money(fee.totalCents / 100, data.currency)}`}
					</button>
				</form>
			</Elements>
		{:else}
			<div class="loader">Loading secure payment form…</div>
		{/if}
	</div>
</div>

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }
	.card { background: white; border: 1px solid var(--grey-line); border-radius: 16px; padding: 28px; max-width: 520px; margin: 0 auto; }
	.back { font-size: 13px; color: var(--grey-text); text-decoration: none; }
	.back:hover { color: var(--navy); }
	h1 { font-size: 30px; font-weight: 800; color: var(--navy); margin: 10px 0 4px; }
	.desc { color: var(--grey-text); font-size: 14px; margin: 0 0 18px; }
	.loader { color: var(--grey-text); padding: 20px 0; }
</style>
