<script lang="ts">
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { loadStripe, type Stripe, type StripeElements } from '@stripe/stripe-js';
	import { Elements, PaymentElement } from 'svelte-stripe';
	// Use dynamic env so a missing var surfaces a clear runtime message
	// instead of a build-time import failure that 500s the page.
	import { env } from '$env/dynamic/public';
	import type { PageData } from './$types';

	const PUBLIC_STRIPE_KEY = env.PUBLIC_STRIPE_KEY ?? '';

	export let data: PageData;

	let stripe: Stripe | null = null;
	let clientSecret = '';
	let initError: string | null = null;
	let formError: string | null = null;
	let submitting = false;
	// svelte-stripe v2: the StripeElements instance is exposed via
	// `bind:elements` on the <Elements> component. The PaymentElement child
	// renders the form; we hand `elements` to stripe.confirmPayment().
	let elements: StripeElements | undefined;

	onMount(async () => {
		try {
			if (!PUBLIC_STRIPE_KEY) {
				throw new Error(
					'PUBLIC_STRIPE_KEY is not set. Add it to samdoctor-web/.env (use the same pk_test_… value as STRIPE_PUBLISHABLE_KEY) and restart the dev server.'
				);
			}
			stripe = await loadStripe(PUBLIC_STRIPE_KEY);
			if (!stripe) throw new Error('Stripe failed to load.');

			const res = await fetch('/api/checkout/payment_intent', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					pricebookEntryIds: data.pricebookEntryIds,
					storeId: data.storeId,
					kind: data.kind,
					termMonths: data.recurring?.termMonths ?? null,
					payOption: data.recurring?.payOption ?? null
				})
			});
			if (!res.ok) {
				const text = await res.text();
				throw new Error(text || `Could not initialize payment (${res.status}).`);
			}
			const body = (await res.json()) as { clientSecret: string };
			clientSecret = body.clientSecret;
		} catch (e) {
			initError = e instanceof Error ? e.message : 'Could not initialize payment.';
		}
	});

	async function handleSubmit() {
		if (!stripe || !elements || submitting) return;
		formError = null;
		submitting = true;

		const result = await stripe.confirmPayment({
			elements,
			confirmParams: {
				return_url: `${window.location.origin}/checkout/success`
			}
		});

		// Stripe redirects on success; if we got back here, it's an error.
		if (result.error) {
			formError = result.error.message ?? 'Payment failed. Please try again.';
		}
		submitting = false;
	}

	function formatPrice(amount: number, c: string) {
		try {
			return new Intl.NumberFormat('en-US', { style: 'currency', currency: c }).format(amount);
		} catch {
			return `$${amount.toFixed(2)} ${c}`;
		}
	}
</script>

<svelte:head><title>Payment — Appeals Doctor</title></svelte:head>

<div class="wrap">
	<div class="card">
		<header>
			<a class="back-link" href={`/checkout/summary?${$page.url.searchParams.toString()}`}>
				← Back to summary
			</a>
			<h1>Payment</h1>
			<p class="sub">Charging {formatPrice(data.chargeTotal, data.currency)} now for {data.pricebookEntryIds.length}
				service{data.pricebookEntryIds.length === 1 ? '' : 's'}.</p>
		</header>

		<!-- Mini line-item recap so the user knows what they're paying for -->
		<ul class="recap">
			{#each data.items as item}
				<li>
					<span>{item.name}{item.quantity > 1 ? ` × ${item.quantity}` : ''}</span>
					<strong>{formatPrice(item.dueNow, item.currency)}{#if item.dueNow < item.lineTotal} <small class="of">of {formatPrice(item.lineTotal, item.currency)}</small>{/if}</strong>
				</li>
			{/each}
			{#if data.fee > 0}
				<li class="fee-row">
					<span>Card processing fee <small class="of">(charged by Stripe)</small></span>
					<strong>{formatPrice(data.fee, data.currency)}</strong>
				</li>
			{/if}
			<li class="total-row">
				<span>Charged now</span>
				<strong>{formatPrice(data.chargeTotal, data.currency)}</strong>
			</li>
		</ul>
		{#if data.balanceTotal > 0}
			<p class="split-note">
				The remaining <strong>{formatPrice(data.balanceTotal, data.currency)}</strong> of your {formatPrice(data.orderTotal, data.currency)} order is
				<strong>not charged today</strong>. It is billed as separate payments when each case is completed, and you'll see every payment on your
				<a href="/payments">Payments</a> screen.
			</p>
		{/if}

		{#if initError}
			<div class="alert alert-error">{initError}</div>
		{:else if clientSecret && stripe}
			<Elements {stripe} {clientSecret} bind:elements>
				<form on:submit|preventDefault={handleSubmit}>
					<PaymentElement />
					{#if formError}
						<div class="alert alert-error" style="margin-top:14px">{formError}</div>
					{/if}
					<button class="btn btn-primary btn-full" type="submit"
						style="margin-top:18px" disabled={submitting || !elements}>
						{submitting ? 'Processing…' : `Pay ${formatPrice(data.chargeTotal, data.currency)}`}
					</button>
				</form>
			</Elements>
		{:else}
			<div class="loader">Loading checkout…</div>
		{/if}
	</div>
</div>

<style>
	.wrap { min-height: 100vh; display: grid; place-items: center; padding: 32px 20px; background: #f7f7f9; }
	.card {
		background: white; border-radius: 20px; padding: 32px;
		width: 100%; max-width: 520px; box-shadow: var(--shadow-xl);
	}
	header { margin-bottom: 20px; }
	.back-link {
		font-size: 13px; color: var(--grey-text); text-decoration: none;
		display: inline-block; margin-bottom: 8px;
	}
	.back-link:hover { color: var(--navy); }
	h1 { font-size: 22px; font-weight: 800; color: var(--navy); margin: 0; }
	.sub { color: var(--grey-text); margin-top: 4px; font-size: 14px; }

	.recap {
		list-style: none; margin: 0 0 18px; padding: 0;
		border: 1px solid var(--grey-line); border-radius: 12px;
		background: #fafafa;
	}
	.recap li {
		display: flex; justify-content: space-between; gap: 12px;
		padding: 10px 14px; font-size: 13px;
		border-bottom: 1px solid var(--grey-line);
	}
	.recap li:last-child { border-bottom: none; }
	.of { font-weight: 500; color: var(--grey-text); font-size: 11px; }
	.split-note { font-size: 13px; background: var(--orange-lt); border: 1px solid var(--orange); border-radius: var(--radius); padding: 10px 14px; margin: 12px 0; color: var(--navy); line-height: 1.5; }
	.recap li.fee-row { font-size: 13px; color: var(--grey-text); }
	.recap li.total-row { font-size: 14px; font-weight: 700; color: var(--navy); }
	.recap li strong { font-variant-numeric: tabular-nums; }

	.loader {
		text-align: center; padding: 24px; color: var(--grey-text); font-size: 14px;
	}
</style>
