<script lang="ts">
	import Topbar from '$components/layout/Topbar.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	function fmtMoney(amount: number, currency: string) {
		try {
			return new Intl.NumberFormat('en-US', {
				style: 'currency', currency: currency.toUpperCase()
			}).format(amount);
		} catch {
			return `${amount.toFixed(2)} ${currency.toUpperCase()}`;
		}
	}
	function fmtMoneyCents(cents: number, currency: string) {
		return fmtMoney(cents / 100, currency);
	}
	function fmtDate(iso: string) {
		try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
		catch { return iso; }
	}
	function fmtDateTime(iso: string | null) {
		if (!iso) return '—';
		try {
			const d = new Date(iso);
			return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
				' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
		} catch { return iso; }
	}

	$: subtotal = data.lineItems.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

	function caseBadge(status: string): string {
		const s = status.toLowerCase();
		if (s.includes('closed') || s.includes('resolved')) return 'badge-green';
		if (s.includes('waiting') || s.includes('pending')) return 'badge-orange';
		return 'badge-grey';
	}
</script>

<svelte:head><title>Contract {data.contract.stripePaymentIntentId} — Appeals Doctor</title></svelte:head>

<Topbar
	title="Service Contract"
	subtitle={`${data.lineItems.length} service${data.lineItems.length === 1 ? '' : 's'} · ${fmtMoneyCents(data.contract.amountCents, data.contract.currency)}`}
>
	<a class="btn btn-outline btn-sm" href="/payments">← All contracts</a>
</Topbar>

<div class="content-area">
	<!-- Sync status banner -->
	{#if data.contract.syncStatus === 'failed'}
		<div class="alert alert-warn" style="margin-bottom:16px">
			This contract failed to sync to Salesforce. Reason:
			<code>{data.contract.syncError ?? 'unknown'}</code>. The local record is intact;
			our team will reconcile.
		</div>
	{:else if data.contract.syncStatus === 'pending'}
		<div class="alert alert-info" style="margin-bottom:16px">
			Salesforce sync is pending.
		</div>
	{/if}

	<!-- Top: Summary + Stripe + SF cards -->
	<div class="grid-2" style="margin-bottom:18px">
		<div class="card">
			<div class="card-title">Contract Summary</div>
			<div class="fields-2col">
				<div class="field-block">
					<div class="field-label">Store</div>
					<div class="field-value">
						{#if data.contract.storeName}
							<a href={`/stores/${data.contract.storeId}`}>{data.contract.storeName}</a>
						{:else}—{/if}
					</div>
				</div>
				<div class="field-block">
					<div class="field-label">Term</div>
					<div class="field-value">{data.contract.termMonths} months</div>
				</div>
				<div class="field-block">
					<div class="field-label">Start Date</div>
					<div class="field-value">{fmtDate(data.contract.startDate)}</div>
				</div>
				<div class="field-block">
					<div class="field-label">End Date</div>
					<div class="field-value">{fmtDate(data.contract.endDate)}</div>
				</div>
				<div class="field-block">
					<div class="field-label">Amount Paid</div>
					<div class="field-value">
						<strong style="color:var(--orange)">{fmtMoneyCents(data.contract.amountCents, data.contract.currency)}</strong>
					</div>
				</div>
				<div class="field-block">
					<div class="field-label">Paid On</div>
					<div class="field-value">{fmtDateTime(data.contract.paidAt)}</div>
				</div>
			</div>
		</div>

		<div class="card">
			<div class="card-title">Stripe</div>
			<div class="fields-2col">
				<div class="field-block">
					<div class="field-label">Payment Intent</div>
					<div class="field-value mono">{data.contract.stripePaymentIntentId}</div>
				</div>
				<div class="field-block">
					<div class="field-label">Charge</div>
					<div class="field-value mono">{data.contract.stripeChargeId ?? '—'}</div>
				</div>
				<div class="field-block">
					<div class="field-label">Payment Method</div>
					<div class="field-value">{data.contract.stripePaymentMethodType ?? '—'}</div>
				</div>
				<div class="field-block">
					<div class="field-label">Payment Method Id</div>
					<div class="field-value mono">{data.contract.stripePaymentMethodId ?? '—'}</div>
				</div>
				<div class="field-block full">
					<div class="field-label">Receipt Email</div>
					<div class="field-value">{data.contract.stripeReceiptEmail ?? '—'}</div>
				</div>
			</div>
		</div>
	</div>

	<div class="card" style="margin-bottom:18px">
		<div class="card-title">
			Purchased Services
			<span style="font-size:11px;font-weight:500;color:var(--grey-text)">
				Subtotal: {fmtMoney(subtotal, data.contract.currency)}
			</span>
		</div>
		<table class="line-table">
			<thead>
				<tr>
					<th>Service</th>
					<th>Category</th>
					<th class="right">Unit Price</th>
					<th class="right">Qty</th>
					<th class="right">Line Total</th>
				</tr>
			</thead>
			<tbody>
				{#each data.lineItems as li (li.id)}
					<tr>
						<td>
							<div class="svc-name">{li.productName}</div>
							{#if li.productDescription}
								<div class="svc-desc">{li.productDescription}</div>
							{/if}
							{#if li.sfdcPricebookEntryId}
								<div class="mono-tiny">
									PE: {li.sfdcPricebookEntryId}{#if li.sfdcContractLineItemId} · CLI: {li.sfdcContractLineItemId}{/if}
								</div>
							{/if}
						</td>
						<td>{li.productCategory ?? '—'}</td>
						<td class="right">{fmtMoney(li.unitPrice, li.currency)}</td>
						<td class="right">{li.quantity}</td>
						<td class="right"><strong>{fmtMoney(li.unitPrice * li.quantity, li.currency)}</strong></td>
					</tr>
				{:else}
					<tr><td colspan="5" class="empty">No line items recorded.</td></tr>
				{/each}
			</tbody>
			<tfoot>
				<tr>
					<td colspan="4" class="right total-label">Total Paid</td>
					<td class="right total-amount">{fmtMoneyCents(data.contract.amountCents, data.contract.currency)}</td>
				</tr>
			</tfoot>
		</table>
	</div>

	<div class="card">
		<div class="card-title">Cases</div>
		{#if data.casesError}
			<div class="alert alert-error" style="margin:0 0 4px">Could not load cases: {data.casesError}</div>
		{:else if data.cases.length === 0}
			<p class="empty" style="padding:12px 0">No cases yet for this contract. They appear once the service contract syncs.</p>
		{:else}
			<table class="line-table">
				<thead>
					<tr>
						<th>Case</th>
						<th>Subject</th>
						<th>Status</th>
						<th>Priority</th>
						<th>Updated</th>
					</tr>
				</thead>
				<tbody>
					{#each data.cases as c (c.Id)}
						<tr
							class:clickable={!!data.localStoreId}
							on:click={() => {
								if (data.localStoreId) location.assign(`/stores/${data.localStoreId}/issues/${c.Id}`);
							}}
						>
							<td class="mono">{c.CaseNumber}</td>
							<td>{c.Subject ?? '—'}</td>
							<td><span class={`badge ${caseBadge(c.Status)}`}>{c.Status}</span></td>
							<td>{c.Priority ?? '—'}</td>
							<td>{fmtDateTime(c.LastModifiedDate)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		{/if}
	</div>

	<div class="card">
		<div class="card-title">Salesforce</div>
		<div class="fields-2col">
			<div class="field-block">
				<div class="field-label">Sync Status</div>
				<div class="field-value">
					{#if data.contract.syncStatus === 'synced'}
						<span class="badge badge-green">Synced</span>
					{:else if data.contract.syncStatus === 'failed'}
						<span class="badge badge-orange">Failed</span>
					{:else}
						<span class="badge badge-grey">Pending</span>
					{/if}
				</div>
			</div>
			<div class="field-block">
				<div class="field-label">Synced At</div>
				<div class="field-value">{fmtDateTime(data.contract.syncedAt)}</div>
			</div>
			<div class="field-block">
				<div class="field-label">ServiceContract Id</div>
				<div class="field-value mono">{data.contract.sfdcServiceContractId ?? '—'}</div>
			</div>
			<div class="field-block">
				<div class="field-label">Account Id</div>
				<div class="field-value mono">{data.contract.sfdcAccountId ?? '—'}</div>
			</div>
			<div class="field-block">
				<div class="field-label">Contact Id</div>
				<div class="field-value mono">{data.contract.sfdcContactId ?? '—'}</div>
			</div>
			<div class="field-block">
				<div class="field-label">Store Id</div>
				<div class="field-value mono">{data.contract.sfdcStoreId ?? '—'}</div>
			</div>
		</div>
	</div>
</div>

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }
	.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
	.card {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 18px 20px;
	}
	.card-title {
		display: flex; justify-content: space-between; align-items: center;
		font-size: 14px; font-weight: 700; color: var(--navy);
		padding-bottom: 10px; margin-bottom: 14px;
		border-bottom: 1px solid var(--grey-line);
	}

	.fields-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
	.field-block { min-width: 0; }
	.field-block.full { grid-column: 1 / -1; }
	.field-label {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text); margin-bottom: 3px;
	}
	.field-value { font-size: 14px; font-weight: 500; word-break: break-word; }
	.field-value.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
	.field-value a { color: var(--orange); text-decoration: none; }
	.field-value a:hover { text-decoration: underline; }

	.line-table { width: 100%; border-collapse: collapse; font-size: 13px; }
	.line-table thead th {
		text-align: left; padding: 9px 12px; font-size: 11px; font-weight: 700;
		text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text);
		border-bottom: 1px solid var(--grey-line); background: #fafafa;
	}
	.line-table .right { text-align: right; font-variant-numeric: tabular-nums; }
	.line-table tbody td { padding: 12px; border-bottom: 1px solid var(--grey-line); vertical-align: top; }
	.svc-name { font-weight: 600; color: var(--navy); }
	.svc-desc { font-size: 11px; color: var(--grey-text); margin-top: 3px; }
	.mono-tiny {
		font-family: ui-monospace, monospace; font-size: 10px;
		color: var(--grey-text); margin-top: 4px;
	}
	.line-table tfoot td { padding: 14px 12px; font-weight: 700; border-top: 2px solid var(--navy); }
	.total-label { color: var(--grey-text); text-transform: uppercase; font-size: 12px; }
	.total-amount { font-size: 18px; color: var(--navy); }
	.empty { text-align: center; padding: 20px; color: var(--grey-text); }

	tr.clickable { cursor: pointer; }
	tr.clickable:hover { background: var(--grey-bg); }
	.badge { display: inline-block; padding: 3px 10px; font-size: 11px; font-weight: 700; border-radius: 12px; }
	.badge-green { background: #d1fae5; color: #047857; }
	.badge-orange { background: #fff1de; color: #b45309; }
	.badge-grey { background: #e5e7eb; color: #374151; }

	.alert { border-radius: 9px; padding: 12px 16px; font-size: 13px; }
	.alert-info { background: #dbeafe; border: 1px solid #93c5fd; color: #1e40af; }
	.alert-warn { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; }
	.alert code { background: rgba(0,0,0,.05); padding: 1px 5px; border-radius: 3px; font-family: ui-monospace, monospace; }
</style>
