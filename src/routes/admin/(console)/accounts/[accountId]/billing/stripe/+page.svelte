<script lang="ts">
	import { useAdminTime } from '$lib/admin/tz';
	import { enhance } from '$app/forms';
	import RecordModal from '$lib/components/admin/RecordModal.svelte';
	import type { ActionData, PageData } from './$types';
	const { fmt: fmtT, fmtDate: fmtD0 } = useAdminTime();
	export let data: PageData;
	export let form: ActionData;
	let busy = false;
	let looking = false;
	let importing = false;
	let transactionId = '';
	let reason = '';
	let confirmOwner = false;
	/** The looked-up transaction; kept in the page until another lookup or a successful import. */
	let preview: NonNullable<Extract<ActionData, { preview: unknown }>>['preview'] | null = null;
	let pushing: PageData['payments'][number] | null = null;
	$: accept(form);
	function accept(f: ActionData) {
		if (f && 'preview' in f && f.preview) { preview = f.preview; reason = ''; confirmOwner = false; }
	}
	const SF_STATE: Record<string, [string, string, string]> = {
		applied: ['In Salesforce', '#DCFCE7', '#15803d'], pending: ['Not in Salesforce', '#FEF3C7', '#92400e'],
		failed: ['Salesforce update failed', '#FEE2E2', '#b91c1c'], mismatch: ['Amount mismatch', '#FEE2E2', '#b91c1c'],
		already_paid: ['Paid by another charge', '#FEE2E2', '#b91c1c']
	};
	const money = (c: string | null, cur: string | null) => (c == null ? '—' : `${(Number(c) / 100).toFixed(2)} ${(cur ?? '').toUpperCase()}`);
	$: d = (v: Date | string | null) => (v ? $fmtT(v) : '—');
</script>

<svelte:head><title>Billing — Admin</title></svelte:head>
{#if form && 'ok' in form && form.ok}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'error' in form && typeof form.error === 'string' && !('stripe' in form)}<div class="adm-alert error" role="alert">{form.error}</div>{/if}

{#if data.canSync}
<div class="adm-card">
	<h2>Import a transaction from Stripe</h2>
	<p class="adm-muted">For a payment the app missed. Enter its Stripe ID: a payment (pi_), charge (ch_), checkout session (cs_) or invoice (in_). Looking it up changes nothing.</p>
	<form class="lookup" method="POST" action="?/lookup" use:enhance={() => { looking = true; preview = null; return async ({ update }) => { await update({ reset: false }); looking = false; }; }}>
		<input class="adm-input grow" name="transactionId" aria-label="Stripe transaction ID" placeholder="pi_…" autocomplete="off" required maxlength="255" bind:value={transactionId} />
		<button class="adm-btn" type="submit" disabled={looking || !transactionId.trim()}>{looking ? 'Checking Stripe…' : 'Look up'}</button>
	</form>
	{#if preview}
		<dl class="facts">
			<div><dt>Type</dt><dd>{preview.kindLabel}</dd></div>
			<div><dt>Stripe status</dt><dd>{preview.status}</dd></div>
			<div><dt>Charged</dt><dd>{preview.amount.toFixed(2)} {preview.currency}</dd></div>
			<div><dt>Date</dt><dd>{d(preview.paidAt)}</dd></div>
			<div><dt>Receipt email</dt><dd>{preview.email ?? '—'}</dd></div>
			<div><dt>Payment ID</dt><dd class="adm-mono">{preview.paymentIntentId}</dd></div>
			<div><dt>Saved in app</dt><dd>Payment: {preview.recorded ? 'yes' : 'no'} · Contract: {preview.contractInApp ? 'yes' : 'no'}</dd></div>
			<div><dt>Salesforce</dt><dd>{preview.sfPaymentName ? `${preview.sfPaymentName} (${preview.sfPaymentStatus ?? 'no status'})` : preview.sfError ? 'Could not be read' : 'No payment record'}{#if preview.sfContractId} · <span class="adm-mono">{preview.sfContractId}</span>{/if}</dd></div>
		</dl>
		{#if preview.blocker}
			<div class="adm-alert error" role="alert">{preview.blocker}{#if preview.otherAccountId} <a href="/admin/accounts/{preview.otherAccountId}/billing/stripe">Open that account</a>{/if}</div>
		{:else}
			<p><strong>Import will:</strong> {preview.plan} Salesforce is not changed.</p>
			{#if preview.kind === 'checkout' && !preview.contractInApp}<p class="adm-muted">Line item names and prices come from the current price book; the contract amount comes from Stripe.</p>{/if}
			<form class="importform" method="POST" action="?/import" use:enhance={() => { importing = true; return async ({ result, update }) => { await update({ reset: false }); importing = false; if (result.type === 'success') { preview = null; transactionId = ''; } }; }}>
				<input type="hidden" name="transactionId" value={preview.id} />
				{#if preview.ownership === 'unverified'}
					<div class="adm-alert warn">Nothing in Stripe or Salesforce links this transaction to an account.</div>
					<label class="check"><input type="checkbox" name="confirmOwner" bind:checked={confirmOwner} /> I checked: it belongs to this account</label>
				{:else}<p class="adm-muted">Matched to this account by: {preview.evidence.join(', ')}.</p>{/if}
				<div class="lookup">
					<input class="adm-input grow" name="reason" aria-label="Reason" placeholder="Reason (required, 5–500 characters)" required minlength="5" maxlength="500" bind:value={reason} />
					<button class="adm-btn" type="submit" disabled={importing || reason.trim().length < 5 || (preview.ownership === 'unverified' && !confirmOwner)}>{importing ? 'Importing…' : 'Import into the app'}</button>
				</div>
			</form>
		{/if}
	{/if}
</div>
{/if}

<div class="adm-card">
	<h2>Recorded Stripe payments</h2>
	{#if data.payments.length === 0}<div class="adm-empty">No Stripe payments recorded yet.</div>{:else}
		<div class="adm-table-wrap"><table class="adm-table">
			<caption class="adm-sr">Recorded Stripe payments</caption>
			<thead><tr><th scope="col">Paid</th><th scope="col">Charged</th><th scope="col">Type</th><th scope="col">Stripe payment</th><th scope="col">Contract</th><th scope="col">Salesforce</th><th scope="col"><span class="adm-sr">Actions</span></th></tr></thead>
			<tbody>
				{#each data.payments as p (p.stripe_payment_intent_id)}
					{@const st = SF_STATE[p.sf_status] ?? [p.sf_status, '#F1F5F9', '#475569']}
					<tr>
						<td>{d(p.paid_at)}{#if p.imported_at}<div class="adm-muted">Imported</div>{/if}</td>
						<td>{money(p.charged_cents, p.currency)}</td>
						<td>{p.kind}</td>
						<td class="adm-mono">{#if p.stripeUrl}<a href={p.stripeUrl} target="_blank" rel="noreferrer">{p.stripe_payment_intent_id}</a>{:else}{p.stripe_payment_intent_id}{/if}</td>
						<td>{p.has_contract ? 'Saved' : 'Not saved'}</td>
						<td><span class="chip" style="background:{st[1]};color:{st[2]}">{st[0]}</span>{#if p.sfdc_payment_name}<div class="adm-muted">{p.sfdc_payment_name}</div>{/if}{#if p.sf_error}<div class="adm-muted">{p.sf_error}</div>{/if}</td>
						<td>{#if data.canSync && p.sf_status !== 'applied' && (p.kind === 'balance' || p.kind === 'renewal')}<button type="button" class="adm-btn outline sm" on:click={() => (pushing = p)}>Send to Salesforce</button>{/if}</td>
					</tr>
				{/each}
			</tbody></table></div>
	{/if}
</div>

{#if pushing}
	<RecordModal kind="sync" title="Send payment to Salesforce"
		body={pushing.kind === 'balance' ? 'Marks the existing Salesforce payment record Paid with these Stripe details. Logged with your reason.' : 'Creates the renewal payment record in Salesforce, unless one already exists for this transaction. Logged with your reason.'}
		recordName={money(pushing.charged_cents, pushing.currency)} recordId={pushing.stripe_payment_intent_id}
		action="?/push" hidden={{ paymentIntentId: pushing.stripe_payment_intent_id }} submitLabel="Send to Salesforce" on:close={() => (pushing = null)} />
{/if}

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

<style>
	.lookup { display: flex; gap: 8px; align-items: center; }
	.grow { flex: 1; min-width: 0; }
	.facts { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 10px 18px; margin: 14px 0; }
	.facts dt { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--grey-text); }
	.facts dd { margin: 2px 0 0; font-size: 13px; overflow-wrap: anywhere; }
	.importform { display: flex; flex-direction: column; gap: 10px; }
	.check { display: flex; gap: 8px; align-items: center; font-size: 13px; }
	.chip { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
</style>
