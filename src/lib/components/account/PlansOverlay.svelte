<script lang="ts">
	import { createEventDispatcher } from 'svelte';

	export let categories: { category: string; products: any[] }[];
	export let activePlanEntryId: string | null;
	export let activePlanName: string | null;
	export let activePlanEndDate: string | null;
	export let activePlanCancelling = false;
	export let activeStripeSubscriptionId: string | null;
	export let storeCount: number;

	const dispatch = createEventDispatcher<{ close: void }>();

	$: rows = categories
		.flatMap((cat) => cat.products.map((p) => ({ ...p, categoryLabel: cat.category })))
		.sort((a, b) => a.unitPrice - b.unitPrice);
	$: currentPlanName = activePlanName ?? rows.find((r) => r.pricebookEntryId === activePlanEntryId)?.name ?? null;

	let busy = false;
	let cancelling = false;
	let subscribeError: string | null = null;
	let cancelError: string | null = null;

	function formatPrice(amount: number, c: string) {
		try {
			return new Intl.NumberFormat('en-US', {
				style: 'currency', currency: c, maximumFractionDigits: 0
			}).format(amount);
		} catch {
			return `$${amount.toLocaleString()} ${c}`;
		}
	}

	// Starts a real, recurring Stripe Subscription via Stripe Checkout
	// (hosted by Stripe) instead of the one-off PaymentIntent flow used for
	// single services.
	async function subscribe(pricebookEntryId: string) {
		if (busy) return;
		busy = true;
		subscribeError = null;
		try {
			const res = await fetch('/api/checkout/subscription', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pricebookEntryId })
			});
			if (!res.ok) throw new Error((await res.text()) || 'Could not start checkout.');
			const body = (await res.json()) as { url: string };
			window.location.href = body.url;
		} catch (e) {
			subscribeError = e instanceof Error ? e.message : 'Could not start checkout.';
			busy = false;
		}
	}

	// Stripe hosts subscription management (including cancellation) in its
	// Billing Portal — redirect there rather than building a custom cancel UI.
	async function cancelSubscription() {
		if (cancelling) return;
		cancelling = true;
		cancelError = null;
		try {
			const res = await fetch('/api/checkout/billing-portal', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({})
			});
			if (!res.ok) throw new Error((await res.text()) || 'Could not open subscription management.');
			const body = (await res.json()) as { url: string };
			window.location.href = body.url;
		} catch (e) {
			cancelError = e instanceof Error ? e.message : 'Could not open subscription management.';
			cancelling = false;
		}
	}
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && dispatch('close')} />

<div class="overlay" role="dialog" aria-modal="true" aria-label="Subscription and plans">
	<div class="ov-head">
		<div>
			<nav class="ov-crumbs" aria-label="Breadcrumb">
				<button type="button" class="link" on:click={() => dispatch('close')}>Account</button><span>/</span>
				<span class="cur">Subscription &amp; plans</span>
			</nav>
			<h2>Choose how much cover you want</h2>
		</div>
		<button type="button" class="ov-x" aria-label="Close" title="Close" on:click={() => dispatch('close')}>✕</button>
	</div>
	<div class="ov-scroll">
		{#if activePlanEntryId}
			<div class="active-banner">
				<div>
					{#if activePlanCancelling}
						Your <strong>{currentPlanName ?? 'plan'}</strong> is cancelled and <strong>ends {activePlanEndDate}</strong>. It stays fully active until then and you won't be charged again.
						Subscribe to a plan below to keep your cover.
					{:else}
						You're on <strong>{currentPlanName ?? 'a plan'}</strong>{activePlanEndDate ? ` · renews ${activePlanEndDate}` : ''}.
						Switching starts a new plan and cancels this one — we'll show the difference before you pay.
					{/if}
				</div>
				{#if activeStripeSubscriptionId && !activePlanCancelling}
					<button type="button" class="btn btn-outline btn-sm" data-mutates disabled={cancelling} on:click={cancelSubscription}>
						{cancelling ? 'Opening…' : 'Cancel subscription'}
					</button>
				{/if}
			</div>
			{#if cancelError}<div class="alert alert-error" style="margin-bottom:18px">{cancelError}</div>{/if}
		{:else}
			<div class="active-banner">Pick a plan for your account. It covers every store ({storeCount}) and renews yearly — you can switch any time.</div>
		{/if}
		{#if subscribeError}<div class="alert alert-error" style="margin-bottom:18px">{subscribeError}</div>{/if}

		{#if rows.length === 0}
			<div class="empty">No subscription plans available right now.</div>
		{:else}
			<div class="plans">
				{#each rows as r (r.pricebookEntryId)}
					{@const isCurrent = r.pricebookEntryId === activePlanEntryId}
					<div class="plan-card" class:current={isCurrent}>
						{#if isCurrent}<span class="badge-current">Your plan</span>{/if}
						<div class="plan-name">{r.name}</div>
						{#if r.description}<div class="plan-desc">{r.description}</div>{/if}
						<div class="plan-price">{formatPrice(r.unitPrice, r.currency)}<span class="plan-price-unit">/year</span></div>
						<div class="plan-price-monthly">works out to {formatPrice(r.unitPrice / 12, r.currency)} a month</div>
						<button type="button" data-mutates class="btn {isCurrent ? 'btn-outline' : 'btn-primary'} btn-full"
							disabled={isCurrent || busy} on:click={() => subscribe(r.pricebookEntryId)}>
							{isCurrent ? "You're on this plan" : busy ? 'Loading…' : `Switch to ${r.name}`}
						</button>
					</div>
				{/each}
			</div>
		{/if}

		<div class="faq">
			<div class="faq-item"><div class="faq-q">What happens after 12 months?</div><div class="faq-a">It renews at the same price unless you cancel. We email you 30 days before.</div></div>
			<div class="faq-item"><div class="faq-q">Can I buy a single fix instead?</div><div class="faq-a">Yes — one-time services are on each store’s Plan &amp; Services tab, no plan needed.</div></div>
			<div class="faq-item"><div class="faq-q">Is this per store?</div><div class="faq-a">No — the subscription is for your whole account and covers every store on it.</div></div>
		</div>
	</div>
</div>

<style>
	.overlay { position: fixed; inset: 0; margin-left: 72px; background: #F6F8FB; z-index: 900; display: flex; flex-direction: column; }
	.ov-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 26px; background: white; border-bottom: 1px solid var(--grey-line); }
	.ov-head h2 { margin: 4px 0 0; font-size: 17px; font-weight: 800; color: var(--navy); }
	.ov-crumbs { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--grey-text); }
	.ov-crumbs .link { background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
	.ov-crumbs .link:hover { text-decoration: underline; color: var(--navy); }
	.ov-crumbs .cur { color: var(--navy); font-weight: 600; }
	.ov-x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); }
	.ov-scroll { flex: 1; overflow-y: auto; padding: 22px 26px 60px; }


	.active-banner {
		display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
		background: #fff5ec; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 12px 16px;
		font-size: 13px; color: var(--navy); margin-bottom: 18px;
	}
	.alert-error { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; border-radius: 9px; padding: 12px 16px; font-size: 13px; }

	.plans { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 18px; align-items: stretch; }

	.plan-card {
		position: relative; display: flex; flex-direction: column;
		background: white; border: 1px solid var(--grey-line); border-radius: var(--radius);
		padding: 22px; transition: border-color .12s;
	}
	.plan-card.current { border-color: var(--navy); border-width: 2px; }

	.plan-name { font-size: 17px; font-weight: 800; color: var(--navy); }
	.plan-desc { font-size: 13px; color: var(--grey-text); margin-top: 8px; line-height: 1.5; flex: 1; }
	.plan-price { font-size: 26px; font-weight: 800; color: var(--navy); margin-top: 16px; }
	.plan-price-unit { font-size: 13px; font-weight: 600; color: var(--grey-text); margin-left: 4px; }
	.plan-price-monthly { font-size: 12px; color: var(--grey-text); margin-bottom: 16px; }

	.badge-current {
		position: absolute; top: 16px; right: 16px;
		font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
		background: var(--navy); color: white; border-radius: 999px; padding: 3px 10px;
	}

	.empty {
		background: white; border: 1px dashed var(--grey-line);
		border-radius: var(--radius); padding: 26px;
		font-size: 14px; color: var(--grey-text); line-height: 1.5;
	}

	.faq { margin-top: 32px; display: flex; flex-direction: column; gap: 18px; max-width: 640px; }
	.faq-q { font-size: 14px; font-weight: 700; color: var(--navy); margin-bottom: 4px; }
	.faq-a { font-size: 13px; color: var(--grey-text); line-height: 1.5; }
	.faq-a a { color: var(--orange-dk); font-weight: 600; text-decoration: none; }
	.faq-a a:hover { text-decoration: underline; }
</style>
