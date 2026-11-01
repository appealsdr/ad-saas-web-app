<script lang="ts">
	import { page } from '$app/stores';
	import RowMenu from '$lib/components/admin/RowMenu.svelte';
	import RecordModal from '$lib/components/admin/RecordModal.svelte';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;

	type C = PageData['contracts'][number];
	const FILTERS = [['all', 'All'], ['active', 'Active'], ['subscription', 'Subscriptions'], ['attention', 'Needs attention'], ['sf', 'Not in Salesforce']] as const;
	let filter: (typeof FILTERS)[number][0] = 'all';
	let search = '';
	let open = new Set<string>();
	let modal: { kind: 'create' | 'sync' | 'repair' | 'delete'; c: C } | null = null;

	const attention = (c: C) => c.payments.some((p) => p.status === 'failed') || c.syncStatus === 'failed';
	const matches = (c: C, f: string) =>
		f === 'all' || (f === 'active' ? (c.status ?? '') === 'active' : f === 'subscription' ? c.kind === 'subscription' : f === 'attention' ? attention(c) : c.sfState !== 'synced');
	$: count = (f: string) => data.contracts.filter((c) => matches(c, f)).length;
	$: list = data.contracts.filter((c) => {
		const q = search.trim().toLowerCase();
		return matches(c, filter) && (!q || [c.ref, c.id, c.storeName, c.sfdcId, c.stripePi, c.stripeSub, ...c.lines.map((l) => l.name)].join(' ').toLowerCase().includes(q));
	});
	$: base = `/admin/accounts/${$page.params.accountId}`;
	$: totals = { amount: list.reduce((n, c) => n + c.amount, 0), paid: list.reduce((n, c) => n + c.payments.filter((p) => p.status === 'paid' && !p.isLine).reduce((a, p) => a + p.amount, 0), 0) };

	const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const fmtD = (iso: string | null) => (iso ? new Date(iso + (iso.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
	const PAY = { paid: ['Paid', '#DCFCE7', '#15803d'], due: ['Due', '#FEF3C7', '#92400e'], failed: ['Failed', '#FEE2E2', '#b91c1c'], closed: ['Closed', '#F1F5F9', '#475569'], inactive: ['Not Active', '#F1F5F9', '#475569'], ready: ['Ready to pay', '#DBEAFE', '#1d4ed8'] } as const;
	const SF = { synced: ['Synced', '#DCFCE7', '#15803d'], not_in_sf: ['Not in Salesforce', '#FEE2E2', '#b91c1c'], unknown: ['Unknown', '#FEF3C7', '#92400e'] } as const;
	function toggle(id: string) { open.has(id) ? open.delete(id) : open.add(id); open = open; }
	function menu(c: C) {
		return [
			{ label: 'View', icon: '👁', href: `${base}/records/contract/${c.id}` },
			{ label: 'Edit', icon: '✏️', href: `${base}/records/contract/${c.id}?edit=1` },
			{ label: 'Create in Salesforce', icon: '＋', disabled: !data.canSync || c.sfState !== 'not_in_sf', title: c.sfState === 'synced' ? 'Already in Salesforce — use Sync to update it' : c.sfState === 'unknown' ? 'Salesforce could not be reached' : undefined, run: () => (modal = { kind: 'create', c }) },
			{ label: 'Sync to Salesforce', icon: '🔄', disabled: !data.canSync || c.sfState !== 'synced', title: c.sfState === 'synced' ? undefined : 'Not in Salesforce yet — create it first', run: () => (modal = { kind: 'sync', c }) },
			{ label: 'Complete missing records', icon: '🛠', disabled: !data.canSync || c.sfState !== 'synced', title: c.sfState === 'synced' ? 'Create any line items, cases or payments Salesforce is missing' : 'Not in Salesforce yet — create it first', run: () => (modal = { kind: 'repair', c }) },
			{ label: 'View in Salesforce', icon: '↗', href: c.sfUrl ?? undefined, disabled: !c.sfUrl, title: c.sfUrl ? undefined : 'No linked Salesforce record' },
			{ label: 'View in Stripe', icon: '↗', href: c.stripeUrl ?? undefined, disabled: !c.stripeUrl, title: c.stripeUrl ? undefined : 'No Stripe reference' },
			{ label: 'Delete', icon: '🗑', danger: true, disabled: !data.canDelete, run: () => (modal = { kind: 'delete', c }) }
		];
	}
</script>

<svelte:head><title>Contracts — Admin</title></svelte:head>
{#if form && 'ok' in form && form.ok}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}
{#if data.paymentsError}<div class="adm-alert warn">Payments could not be loaded from Salesforce ({data.paymentsError}); the Stripe charge is shown instead.</div>{/if}

<div class="adm-card">
	<div class="toolbar">
		<input type="search" class="adm-input search" placeholder="Search contracts by number, store, service, Salesforce ID or Stripe reference…" aria-label="Search contracts" bind:value={search} />
		{#if search}<button type="button" class="adm-btn outline sm" on:click={() => (search = '')}>Clear</button>{/if}
	</div>
	<div class="pillbar">
		{#each FILTERS as [k, label]}<button type="button" class="pill" class:active={filter === k} on:click={() => (filter = k)}>{label} <span>{count(k)}</span></button>{/each}
		<span class="adm-muted foot">Showing {list.length} of {data.contracts.length} contracts · {money(totals.amount)} total · {money(totals.paid)} paid</span>
	</div>
	{#if list.length === 0}
		<div class="adm-empty">{data.contracts.length === 0 ? 'This account has no contracts.' : 'No contracts match these filters.'}</div>
	{:else}
		<div class="adm-table-wrap"><table class="adm-table">
			<caption class="adm-sr">Contracts</caption>
			<thead><tr><th scope="col"></th><th scope="col">Contract</th><th scope="col">Store</th><th scope="col">Status</th><th scope="col">Term</th><th scope="col">Total</th><th scope="col">Services</th><th scope="col">Payments</th><th scope="col">Salesforce</th><th scope="col">Record</th></tr></thead>
			<tbody>
				{#each list as c (c.id)}
					{@const sf = SF[c.sfState]}
					{@const paid = c.payments.filter((p) => !p.isLine && p.status === 'paid').length}
					{@const tops = c.payments.filter((p) => !p.isLine).length}
					<tr>
						<td><button type="button" class="chev" aria-expanded={open.has(c.id)} aria-label="Show services and payments" title="Show services and payments" on:click={() => toggle(c.id)}>{open.has(c.id) ? '▾' : '▸'}</button></td>
						<td><a class="adm-mono" href="{base}/records/contract/{c.id}" title="Open contract">{c.ref}</a><div class="adm-muted">{c.kind === 'subscription' ? 'Subscription' : 'Services'}</div></td>
						<td>{c.storeName ?? '—'}</td>
						<td>{c.status ?? '—'}<div class="adm-muted">{c.paymentStatus ?? ''}</div></td>
						<td>{fmtD(c.startDate)} → {fmtD(c.endDate)}</td>
						<td><strong>{money(c.amount)}</strong></td>
						<td>{c.lines.length}</td>
						<td>{paid} of {tops} paid</td>
						<td><span class="chip" style="background:{sf[1]};color:{sf[2]}">{sf[0]}</span>{#if c.sfdcId}<div class="adm-mono adm-muted">{c.sfdcId}</div>{/if}</td>
						<td><RowMenu items={menu(c)} /></td>
					</tr>
					{#if open.has(c.id)}
						<tr class="detail"><td></td><td colspan="9">
							<div class="two">
								<div>
									<div class="dt">Contract line items</div>
									{#if c.lines.length === 0}<div class="adm-muted">None</div>{:else}
										<table class="adm-table mini"><thead><tr><th scope="col">Service</th><th scope="col">Qty</th><th scope="col">Unit</th><th scope="col">Subtotal</th></tr></thead>
											<tbody>{#each c.lines as l}<tr><td>{l.name}</td><td>{l.qty}</td><td>{money(l.unit)}</td><td>{money(l.qty * l.unit)}</td></tr>{/each}</tbody></table>
									{/if}
								</div>
								<div>
									<div class="dt">Payments</div>
									<table class="adm-table mini"><thead><tr><th scope="col">Payment</th><th scope="col">Type</th><th scope="col">Amount</th><th scope="col">Status</th></tr></thead>
										<tbody>{#each c.payments as p (p.key)}{@const st = PAY[p.status]}<tr class:sub={p.isLine}>
											<td><a href="{base}/billing/payments/{encodeURIComponent(p.key)}">{p.name}</a></td><td>{p.kind}</td><td>{money(p.amount)}</td>
											<td><span class="chip" style="background:{st[1]};color:{st[2]}">{st[0]}</span></td></tr>{/each}</tbody></table>
								</div>
							</div>
						</td></tr>
					{/if}
				{/each}
			</tbody>
		</table></div>
	{/if}
</div>

{#if modal}
	<RecordModal kind={modal.kind === 'delete' ? 'delete' : 'sync'}
		title={modal.kind === 'create' ? 'Create contract in Salesforce' : modal.kind === 'sync' ? 'Sync contract to Salesforce' : modal.kind === 'repair' ? 'Complete missing Salesforce records' : 'Delete contract'}
		body={modal.kind === 'create'
			? 'Rebuilds the ServiceContract and its line items in Salesforce from this purchase record, and links them. Use this when the first sync failed. Cases for services are created like at checkout. Logged with your reason.'
			: modal.kind === 'repair'
				? 'Creates only what Salesforce is missing for this contract: line items, one case per line item, the collected payment, and a pending balance payment for each deposit service. Logged with your reason.'
			: modal.kind === 'sync'
				? 'Pushes the contract’s payment status and dates to its existing Salesforce ServiceContract. Logged with your reason.'
				: 'Deletes this contract and its line items from the app. The Salesforce record and Stripe payments are not touched. Requires recent MFA.'}
		recordName={modal.c.ref} recordId={modal.c.id}
		action={modal.kind === 'delete' ? '?/delete' : '?/resync'}
		hidden={modal.kind === 'delete' ? { targetId: modal.c.id } : { kind: 'contract', targetId: modal.c.id, mode: modal.kind === 'create' ? 'create' : modal.kind === 'repair' ? 'repair' : 'update' }}
		confirmText={modal.c.stripePi ?? modal.c.id}
		submitLabel={modal.kind === 'create' ? 'Create in Salesforce' : modal.kind === 'repair' ? 'Complete missing records' : modal.kind === 'sync' ? 'Push values' : 'Delete contract'} on:close={() => (modal = null)} />
{/if}

<style>
	.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
	.search { flex: 1; }
	.pillbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
	.pill { background: #fff; border: 1px solid var(--grey-line); border-radius: 99px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer; }
	.pill.active { background: var(--navy); border-color: var(--navy); color: #fff; }
	.pill span { opacity: .7; margin-left: 3px; }
	.foot { margin-left: auto; font-size: 12px; }
	.chip { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
	.chev { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; background: #fff; border: 1.5px solid var(--grey-line); border-radius: 8px; cursor: pointer; font-size: 22px; line-height: 1; color: var(--navy); padding: 0; }
	.chev:hover { border-color: var(--navy); background: #F6F8FB; }
	.chev[aria-expanded='true'] { background: var(--navy); border-color: var(--navy); color: #fff; }
	tr.detail td { background: #FAFBFD; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
	.dt { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .06em; color: var(--grey-text); margin-bottom: 6px; }
	.mini { font-size: 12px; } tr.sub td { color: var(--grey-text); }
	@media (max-width: 1000px) { .two { grid-template-columns: 1fr; } }
</style>
