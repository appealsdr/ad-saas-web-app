<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import Topbar from '$components/layout/Topbar.svelte';
	import RequiredFiles from '$components/files/RequiredFiles.svelte';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	let editing = false;
	let saving = false;
	let syncing = false;

	let savingPoc = false;

	// ── Marketplaces multi-select (values from SF Store__c.Marketplaces__c) ──
	$: marketplaceOptions = data.marketplaceOptions ?? [];
	let mpOpen = false;
	let selectedMarketplaces: string[] = [];
	let mpSeeded = false;

	// Seed once per modal-open from the current store value (or an echoed
	// validation-error value).
	$: if (editing && !mpSeeded) {
		const seed = form?.marketplaces ?? data.store.marketplaces ?? '';
		selectedMarketplaces = seed
			.split(/[,;]/)
			.map((s) => s.trim())
			.filter(Boolean);
		mpSeeded = true;
	}
	$: if (!editing) {
		mpSeeded = false;
		mpOpen = false;
	}

	function toggleMarketplace(v: string) {
		selectedMarketplaces = selectedMarketplaces.includes(v)
			? selectedMarketplaces.filter((x) => x !== v)
			: [...selectedMarketplaces, v];
	}
	// Server action reads a single `marketplaces` field (normalized on ',' or ';').
	$: marketplacesValue = selectedMarketplaces.join(';');

	function contactLabel(c: {
		firstName?: string;
		lastName: string;
		email: string;
		title?: string;
		userRole?: string;
	}) {
		const name = `${c.firstName ? c.firstName + ' ' : ''}${c.lastName}`.trim();
		const bits = [name, c.email];
		if (c.title) bits.push(c.title);
		if (c.userRole === 'owner') bits.push('account owner');
		return bits.join(' · ');
	}
	$: showConnectStep = $page.url.searchParams.get('step') === 'connect';
	$: spapiBanner = $page.url.searchParams.get('spapi'); // 'connected' | 'denied' | 'error' | null
	$: if (form?.error) editing = true;

	// ── Status → mockup badge classes ──
	const CASE_STATUS_BADGE: Record<string, string> = {
		new: 'badge-orange', open: 'badge-orange',
		working: 'badge-blue', 'in progress': 'badge-blue',
		'waiting on client': 'badge-red', waiting: 'badge-red', pending: 'badge-red',
		closed: 'badge-green', resolved: 'badge-green'
	};
	function badgeClass(status: string): string {
		return CASE_STATUS_BADGE[status.toLowerCase()] ?? 'badge-grey';
	}
	function isWaitingOnClient(status: string): boolean {
		const s = status.toLowerCase();
		return s.includes('waiting') || s.includes('pending') || s.includes('awaiting');
	}

	// ── Formatters ──
	function fmtDateShort(iso: string | null | undefined) {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
		catch { return iso; }
	}
	function fmtDateTime(iso: string | null | undefined) {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleString(); } catch { return iso; }
	}
	function fmtSize(bytes: number) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	// ── Issue filter (mockup-style pills) ──
	type IssueFilter = 'all' | 'open' | 'in_progress' | 'waiting' | 'resolved';
	let issueFilter: IssueFilter = 'all';

	// Cases | Contracts | Payments tabs
	type Tab = 'cases' | 'contracts' | 'payments';
	let tab: Tab = ($page.url.searchParams.get('tab') as Tab) || 'cases';
	const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const PAY: Record<string, [string, string, string]> = {
		paid: ['Paid', '#DCFCE7', '#15803d'], due: ['Due', '#FEF3C7', '#92400e'], failed: ['Action required', '#FEE2E2', '#b91c1c'],
		closed: ['Closed', '#F1F5F9', '#475569'], inactive: ['Not Active', '#F1F5F9', '#475569'], ready: ['Ready to pay', '#DBEAFE', '#1d4ed8']
	};
	function matchesFilter(status: string, filter: IssueFilter): boolean {
		if (filter === 'all') return true;
		const s = status.toLowerCase();
		if (filter === 'open') return s.includes('open') || s === 'new';
		if (filter === 'in_progress') return s.includes('progress') || s.includes('working');
		if (filter === 'waiting') return s.includes('waiting') || s.includes('pending') || s.includes('awaiting');
		if (filter === 'resolved') return s.includes('closed') || s.includes('resolved');
		return false;
	}
	$: filteredCases = (data.cases ?? []).filter((c) => matchesFilter(c.Status, issueFilter));

	// ── Counts for the financial overview — from Salesforce Store__c rollups,
	//    falling back to a local tally only if the SF field came back null
	//    (e.g. not yet configured in this org). ──
	$: localResolvedCount = (data.cases ?? []).filter((c) => /closed|resolved/i.test(c.Status)).length;
	$: localOpenCount = (data.cases ?? []).filter((c) => !/closed|resolved/i.test(c.Status)).length;
	$: localTotalCount = (data.cases ?? []).length;

	$: resolvedCount = data.metrics.totalClosedCases ?? localResolvedCount;
	$: openCount = data.metrics.totalOpenCases ?? localOpenCount;
	$: totalCount = data.metrics.totalCases ?? localTotalCount;
	$: revenueRecovered = data.metrics.totalRevenueRecovered ?? 0;

	// ── Store Health — literal label from Salesforce Store__c.Store_Health__c ──
	$: healthLabel = data.metrics.storeHealth ?? '—';
	$: healthBadge = (() => {
		const l = (data.metrics.storeHealth ?? '').toLowerCase();
		if (l.includes('excellent') || l.includes('good')) return 'badge-green';
		if (l.includes('risk') || l.includes('warn')) return 'badge-yellow';
		if (l.includes('critical') || l.includes('poor')) return 'badge-red';
		return 'badge-grey';
	})();
	// Bar fill is a visual approximation of the label — Store_Health__c itself
	// is text, not a percentage.
	$: healthFill = healthBadge === 'badge-green' ? 'h-good' : healthBadge === 'badge-yellow' ? 'h-warn' : healthBadge === 'badge-red' ? 'h-crit' : 'h-warn';
	$: healthFillPct = healthBadge === 'badge-green' ? 90 : healthBadge === 'badge-yellow' ? 55 : healthBadge === 'badge-red' ? 20 : 0;

	// ── Store Details records (mockup: cards that open a records overlay) ──
	type RecId = 'info' | 'poc' | 'spapi' | 'health';
	let openRec: RecId | null = null;
	const dash = (v: string | null | undefined) => (v && v.trim() ? v : '—');
	$: marketplaceText = data.store.marketplaces?.split(';').join(', ') ?? '';
	$: pocText = data.pointOfContact ? contactLabel(data.pointOfContact).split(' · ').slice(0, 2).join(' · ') : '—';
	$: storeRecords = [
		{ id: 'info' as RecId, name: 'Store Information', icon: '/icons/store.png', kind: data.store.sfdcStoreId ? 'Local store · mirrored to Salesforce Store__c' : 'Local store · not in Salesforce yet', desc: `${dash(data.store.businessName)} · ${dash(data.store.country)}` },
		{ id: 'poc' as RecId, name: 'Point of Contact', icon: '/icons/account.png', kind: 'Store contact', desc: pocText },
		{ id: 'spapi' as RecId, name: 'SP-API Connection', icon: '/icons/guidance.png', kind: 'Amazon Selling Partner API', desc: spapiLabel(data.store.spapiStatus) + (data.store.spapiConnectedSellerId ? ` · Selling Partner ID ${data.store.spapiConnectedSellerId}` : '') },
		{ id: 'health' as RecId, name: 'Store Health', icon: '/icons/case.png', kind: 'From Salesforce Store__c', desc: `${healthLabel} · ${openCount} open case${openCount === 1 ? '' : 's'} on this store` }
	];
	$: currentRec = storeRecords.find((r) => r.id === openRec) ?? null;
	$: uploadedCount = data.requiredFiles.filter((f) => f.uploaded).length;

	function spapiBadgeClass(s: string): string {
		if (s === 'connected') return 'badge-green';
		if (s === 'error') return 'badge-red';
		return 'badge-grey';
	}
	function spapiLabel(s: string): string {
		if (s === 'connected') return 'Active';
		if (s === 'error') return 'Error';
		return 'Not connected';
	}

</script>

<svelte:head><title>{data.store.name} — Appeals Doctor</title></svelte:head>

<Topbar
	title={data.store.name}
	subtitle={data.store.marketplaces?.split(';').join(' · ') ?? 'Store details'}
>
	{#if !data.store.sfdcStoreId}
		<form
			method="POST"
			action="?/sync_store"
			use:enhance={() => {
				syncing = true;
				return async ({ update }) => {
					await update();
					syncing = false;
				};
			}}
		>
			<button class="btn-sm btn-nav" type="submit" disabled={syncing}>
				{syncing ? 'Syncing…' : 'Sync to Salesforce'}
			</button>
		</form>
	{/if}
	<a class="btn-sm btn-orange" data-mutates href={`/auth/spapi?store=${data.store.id}`}>
		{data.store.spapiStatus === 'connected' ? 'Reconnect SP-API' : 'Connect SP-API'}
	</a>
</Topbar>

<div class="content-area">
	<!-- ── Banners ──────────────────────────────────────────────── -->
	{#if form?.success}<div class="alert alert-success" style="margin-bottom:14px">{form.success}</div>{/if}
	{#if form?.syncSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.syncSuccess}</div>{/if}
	{#if form?.syncError}<div class="alert alert-error" style="margin-bottom:14px">{form.syncError}</div>{/if}
	{#if form?.pocSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.pocSuccess}</div>{/if}
	{#if form?.pocError}<div class="alert alert-error" style="margin-bottom:14px">{form.pocError}</div>{/if}
	{#if form?.uploadSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.uploadSuccess}</div>{/if}
	{#if form?.uploadError}<div class="alert alert-error" style="margin-bottom:14px">{form.uploadError}</div>{/if}

	{#if showConnectStep && data.store.spapiStatus !== 'connected'}
		<div class="alert alert-warn" style="display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:14px">
			<span><strong>Step 2 — connect your Amazon seller account.</strong> You'll be redirected to Seller Central to authorize SP-API.</span>
			<a class="btn-sm btn-orange" data-mutates href={`/auth/spapi?store=${data.store.id}`}>Connect with Amazon →</a>
		</div>
	{/if}
	{#if spapiBanner === 'connected'}
		<div class="alert alert-success" style="margin-bottom:14px">Amazon SP-API connected ✓</div>
	{/if}

	<!-- Persistent "Connected to Amazon" indicator — visible whenever the store
	     is connected, regardless of whether the user just came from OAuth. -->
	{#if data.store.spapiStatus === 'connected'}
		<div class="amazon-link-strip" style="margin-bottom:14px">
			<span class="amazon-mark">⚡</span>
			<div class="link-text">
				<strong>Connected to Amazon</strong>
				<span class="link-sub">
					Selling Partner ID:
					<code>{data.store.spapiConnectedSellerId ?? data.store.sellerId ?? '—'}</code>
					{#if data.store.spapiConnectedAt}
						· since {new Date(data.store.spapiConnectedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
					{/if}
				</span>
			</div>
			<a class="btn-sm btn-nav" data-mutates href={`/auth/spapi?store=${data.store.id}`}>Reconnect</a>
		</div>
	{/if}

	{#if !data.subscription}
		<div class="alert alert-warn no-services-banner" style="margin-bottom:14px">
			<div>
				<strong>No services or subscriptions purchased yet.</strong>
				Buy a service or subscribe to a plan to start getting help with this store.
			</div>
			<div class="no-services-actions">
				<a class="btn-sm btn-orange" href={`/stores/${data.store.id}/services`}>Buy a service →</a>
				<a class="btn-sm btn-nav" href={'/accounts/subscription'}>View plans →</a>
			</div>
		</div>
	{/if}

	{#if spapiBanner === 'denied'}
		<div class="alert alert-error" style="margin-bottom:14px">
			Connection cancelled. {data.store.spapiLastError ?? ''}
		</div>
	{:else if spapiBanner === 'error'}
		<div class="alert alert-error" style="margin-bottom:14px">
			Could not finish connection. {data.store.spapiLastError ?? ''}
		</div>
	{/if}

	<!-- ── Hero ───────────────────────────────────────────────── -->
	<section class="hero">
		<div class="hero-main">
			<div class="hero-title">
				<h1>{data.store.name}</h1>
				<span class={`badge ${spapiBadgeClass(data.store.spapiStatus)}`}>SP-API · {spapiLabel(data.store.spapiStatus)}</span>
				<span class={`badge ${healthBadge}`}>Health · {healthLabel}</span>
			</div>
			<div class="hero-sub">
				{[marketplaceText, data.store.sellerId ? `Seller ID ${data.store.sellerId}` : '', data.pointOfContact ? `Point of contact ${pocText}` : ''].filter(Boolean).join(' · ') || 'Store details'}
			</div>
		</div>
		<div class="hero-rev">
			<span class="rev-label">Revenue recovered</span>
			<span class="rev-amount">${revenueRecovered.toLocaleString()}</span>
			<span class="rev-sub">{resolvedCount} resolved · {openCount} open · {totalCount} total</span>
		</div>
	</section>

	<div class="detail-grid">
		<div class="card tall">
			<div class="card-title">
				Store Details
				<span class="muted-sm">
					{#if data.store.sfdcStoreId}SF: <code>{data.store.sfdcStoreId}</code>{:else}Not in Salesforce{/if}
				</span>
			</div>
			<div class="rec-list">
				{#each storeRecords as r (r.id)}
					<button type="button" class="rec" title={`Open ${r.name}`} on:click={() => (openRec = r.id)}>
						<span class="rec-icon"><img src={r.icon} alt="" /></span>
						<span class="rec-body">
							<span class="rec-name">{r.name}</span>
							<span class="rec-desc">{r.desc}</span>
						</span>
					</button>
				{/each}
			</div>
		</div>

		<div class="card tall">
			<div class="card-title">
				Store Documents
				<span class="muted-sm">{uploadedCount} of {data.requiredFiles.length} uploaded</span>
			</div>
			<div class="docs-scroll">
				{#if data.filesError}
					<div class="alert alert-error" style="margin-bottom:10px">Could not load required files: {data.filesError}</div>
				{:else if !data.store.sfdcStoreId}
					<p style="font-size:13px;color:var(--grey-text);margin:0">
						This store isn't linked to Salesforce yet — required documents will appear here once it is.
					</p>
				{:else}
					<RequiredFiles
						files={data.requiredFiles}
						uploadAction="?/upload_doc"
						clearAction="?/clear_doc"
						multiple
						buildDownloadUrl={(docId) => `/api/stores/${data.store.id}/documents/${docId}`}
						uploadError={form?.uploadError ?? null}
					/>
				{/if}
			</div>
		</div>
	</div>

	<!-- ── Cases | Contracts | Payments ───────────────────────────── -->
	<div class="card" style="margin-bottom:20px">
		<div class="card-title">
			<div class="store-tabs" role="tablist">
				<button type="button" role="tab" aria-selected={tab === 'cases'} class:on={tab === 'cases'} on:click={() => (tab = 'cases')}>Cases <span>{(data.cases ?? []).length}</span></button>
				<button type="button" role="tab" aria-selected={tab === 'contracts'} class:on={tab === 'contracts'} on:click={() => (tab = 'contracts')}>Contracts <span>{data.contracts.length}</span></button>
				<button type="button" role="tab" aria-selected={tab === 'payments'} class:on={tab === 'payments'} on:click={() => (tab = 'payments')}>Payments <span>{data.storePayments.length}</span></button>
			</div>
			<a class="btn-sm btn-orange" href={`/stores/${data.store.id}/services`}>+ New Service</a>
		</div>

		{#if tab === 'contracts'}
			{#if data.billingError}<div class="alert alert-warn" style="margin-bottom:14px">{data.billingError}</div>{/if}
			{#if data.contracts.length === 0}
				<div style="font-size:13px;color:var(--grey-text);padding:20px 0">No service contracts for this store yet. Services you buy for it will appear here.</div>
			{:else}
				<table class="data-table">
					<thead><tr><th>Contract</th><th>Services</th><th>Term</th><th>Total</th><th>Paid</th><th>Payments</th></tr></thead>
					<tbody>
						{#each data.contracts as c (c.id)}
							<tr on:click={() => location.assign(`/payments?contract=${c.id}`)} title="Open contract">
								<td><strong>{c.ref}</strong><div class="sub-line">{c.status ?? ''}</div></td>
								<td>{c.services}</td>
								<td>{c.startDate ? fmtDateShort(c.startDate) : '—'} → {c.endDate ? fmtDateShort(c.endDate) : '—'}</td>
								<td><strong>{money(c.total)}</strong></td>
								<td>{money(c.paid)}</td>
								<td>{c.paymentCount}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		{:else if tab === 'payments'}
			{#if data.billingError}<div class="alert alert-warn" style="margin-bottom:14px">{data.billingError}</div>{/if}
			{#if data.storePayments.length === 0}
				<div style="font-size:13px;color:var(--grey-text);padding:20px 0">No payments for this store yet.</div>
			{:else}
				<table class="data-table">
					<thead><tr><th>Payment</th><th>Contract</th><th>Type</th><th>Amount</th><th>Date</th><th>Status</th><th></th></tr></thead>
					<tbody>
						{#each data.storePayments as p (p.key)}
							{@const st = PAY[p.status] ?? PAY.due}
							<tr on:click={() => location.assign(`/payments?contract=${p.contractId}`)} title="Open payment details">
								<td><strong>{p.name}</strong></td>
								<td>{p.contractRef}</td>
								<td>{p.kind}</td>
								<td><strong>{money(p.amount)}</strong></td>
								<td>{fmtDateShort(p.date)}</td>
								<td><span class="chip-s" style="background:{st[1]};color:{st[2]}">{st[0]}</span></td>
								<td>{#if p.status === 'ready' && p.sfId}<a class="btn-sm btn-orange" href={`/payments/pay/${p.sfId}`} on:click|stopPropagation>Pay</a>{/if}</td>
							</tr>
						{/each}
					</tbody>
				</table>
				<p class="pay-note">Balances for deposit services stay <strong>Not Active</strong> until their case is completed, then become <strong>Ready to pay</strong>.</p>
			{/if}
		{:else}
		{#if data.casesError}
			<div class="alert alert-error" style="margin-bottom:14px">
				Could not load cases from Salesforce: {data.casesError}
			</div>
		{:else if !data.store.sfdcStoreId}
			<div style="font-size:13px;color:var(--grey-text);padding:20px 0">
				This store isn't linked to a Salesforce Store__c yet. Cases will appear here once it is.
			</div>
		{:else}
			<div class="qf-row">
				<button class="qf" class:active={issueFilter === 'all'}         on:click={() => (issueFilter = 'all')}>All</button>
				<button class="qf" class:active={issueFilter === 'open'}        on:click={() => (issueFilter = 'open')}>Open</button>
				<button class="qf" class:active={issueFilter === 'in_progress'} on:click={() => (issueFilter = 'in_progress')}>In Progress</button>
				<button class="qf" class:active={issueFilter === 'waiting'}     on:click={() => (issueFilter = 'waiting')}>Waiting</button>
				<button class="qf" class:active={issueFilter === 'resolved'}    on:click={() => (issueFilter = 'resolved')}>Resolved</button>
			</div>
			<table class="data-table">
				<thead>
					<tr>
						<th>Case ID</th>
						<th>Service</th>
						<th>Status</th>
						<th>Priority</th>
						<th>Opened</th>
						<th>Last Modified</th>
					</tr>
				</thead>
				<tbody>
					{#each filteredCases as c (c.Id)}
						<tr
							class:row-waiting={isWaitingOnClient(c.Status)}
							on:click={() => location.assign(`/stores/${data.store.id}/issues/${c.Id}`)}
						>
							<td><strong>{c.CaseNumber}</strong></td>
							<td>{c.recordTypeName ?? '—'}</td>
							<td><span class={`badge ${badgeClass(c.Status)}`}>{c.Status}</span></td>
							<td>{c.Priority ?? '—'}</td>
							<td>{fmtDateShort(c.CreatedDate)}</td>
							<td>{fmtDateShort(c.LastModifiedDate)}</td>
						</tr>
					{:else}
						<tr><td colspan="6" style="text-align:center;color:var(--grey-text);padding:20px">No cases in this category</td></tr>
					{/each}
				</tbody>
			</table>
		{/if}
		{/if}
	</div>
</div>

<!-- ════════════ Store details records overlay ════════════ -->
{#if currentRec}
	<div class="rec-overlay" role="dialog" aria-modal="true" aria-label="Store details">
		<div class="ov-head">
			<div>
				<nav class="ov-crumbs" aria-label="Breadcrumb">
					<button type="button" class="link" on:click={() => (openRec = null)}>{data.store.name}</button><span>/</span>
					<span class="cur">Store Details</span>
				</nav>
				<h2>{currentRec.name}</h2>
			</div>
			<button type="button" class="ov-x" aria-label="Close" title="Close" on:click={() => (openRec = null)}>✕</button>
		</div>
		<div class="ov-body">
			<aside>
				<div class="aside-head">Records</div>
				{#each storeRecords as r (r.id)}
					<button type="button" class="aside-item" class:active={r.id === currentRec.id} on:click={() => (openRec = r.id)}>{r.name}</button>
				{/each}
			</aside>
			<section class="ov-panel">
				<div class="ov-panel-head">
					<div>
						<div class="ov-kind">{currentRec.kind}</div>
						<div class="ov-name">{currentRec.name}</div>
					</div>
					<div class="ov-actions">
						{#if currentRec.id === 'info'}
							<button class="btn-sm btn-nav" type="button" data-mutates on:click={() => (editing = true)}>Edit</button>
							{#if !data.store.sfdcStoreId}
								<form method="POST" action="?/sync_store" use:enhance={() => {
									syncing = true;
									return async ({ update }) => { await update(); syncing = false; };
								}}>
									<button class="btn-sm btn-orange" type="submit" disabled={syncing}>{syncing ? 'Syncing…' : 'Sync to Salesforce'}</button>
								</form>
							{/if}
						{:else if currentRec.id === 'spapi'}
							<a class="btn-sm btn-orange" data-mutates href={`/auth/spapi?store=${data.store.id}`}>
								{data.store.spapiStatus === 'connected' ? 'Reconnect SP-API' : 'Connect SP-API'}
							</a>
						{/if}
					</div>
				</div>

				{#if currentRec.id === 'info'}
					<div class="ov-fields">
						<div><span>Store name</span><strong>{data.store.name}</strong></div>
						<div><span>Marketplaces</span><strong>{dash(marketplaceText)}</strong></div>
						<div><span>Country</span><strong>{dash(data.store.country)}</strong></div>
						<div><span>Seller ID</span><strong class="mono">{dash(data.store.sellerId)}</strong></div>
						<div><span>Legal business name</span><strong>{dash(data.store.businessName)}</strong></div>
						<div><span>Amazon notification email</span><strong>{dash(data.store.sellerPrimaryEmail)}</strong></div>
						<div><span>Store contact email</span><strong>{dash(data.store.storeEmail)}</strong></div>
						{#if data.store.description}
							<div class="full"><span>Description</span><strong>{data.store.description}</strong></div>
						{/if}
					</div>
				{:else if currentRec.id === 'poc'}
					{#if data.canManageContacts}
						<form method="POST" action="?/set_store_point_of_contact" class="poc-form"
							use:enhance={() => {
								savingPoc = true;
								return async ({ update }) => { savingPoc = false; await update(); };
							}}>
							<select name="contactId" class="form-control poc-select" disabled={savingPoc}>
								{#each data.accountContacts as c (c.id)}
									<option value={c.id} selected={c.id === data.store.pointOfContactId}>{contactLabel(c)}</option>
								{/each}
							</select>
							<button type="submit" class="btn btn-outline btn-sm" disabled={savingPoc || data.accountContacts.length === 0}>
								{savingPoc ? 'Saving…' : 'Update'}
							</button>
						</form>
						<p class="poc-hint">Defaults to the account owner. Used as the primary contact for this store.</p>
					{:else}
						<div class="ov-fields"><div class="full"><span>Point of contact</span><strong>{data.pointOfContact ? contactLabel(data.pointOfContact) : '—'}</strong></div></div>
					{/if}
				{:else if currentRec.id === 'spapi'}
					<div class="ov-fields">
						<div><span>Status</span><strong><span class={`badge ${spapiBadgeClass(data.store.spapiStatus)}`}>{spapiLabel(data.store.spapiStatus)}</span></strong></div>
						<div><span>Connected at</span><strong>{fmtDateTime(data.store.spapiConnectedAt)}</strong></div>
						<div><span>Selling Partner ID</span><strong class="mono">{dash(data.store.spapiConnectedSellerId)}</strong></div>
						{#if data.store.spapiLastError}
							<div class="full"><span>Last error</span><strong class="error-text">{data.store.spapiLastError}</strong></div>
						{/if}
					</div>
				{:else if currentRec.id === 'health'}
					<div class="health-bar" style="height:10px;margin-bottom:16px">
						<div class={`health-fill ${healthFill}`} style="width:{healthFillPct}%"></div>
					</div>
					<div class="ov-fields">
						<div><span>Store health</span><strong><span class={`badge ${healthBadge}`}>{healthLabel}</span></strong></div>
						<div><span>Account</span><strong>{#if data.account}<a href="/accounts">{data.account.name}</a>{:else}—{/if}</strong></div>
						<div><span>Plan</span><strong><a href="/accounts/subscription">{data.subscription ? data.subscription.planName : 'Want to subscribe?'}</a></strong></div>
						<div><span>Open / total cases</span><strong>{openCount} / {totalCount}</strong></div>
					</div>
				{/if}
			</section>
		</div>
	</div>
{/if}

<!-- ════════════ Edit modal (mockup-style) ════════════ -->
{#if editing}
	<div class="modal-overlay open" on:click={() => (editing = false)} role="presentation">
		<div class="modal-box md" on:click|stopPropagation role="dialog" aria-labelledby="edit-store-title">
			<div class="modal-hdr">
				<h3 id="edit-store-title">✏️ Edit Store</h3>
				<button type="button" class="modal-x" on:click={() => (editing = false)} aria-label="Close">✕</button>
			</div>
			<div class="modal-body">
				{#if form?.error}
					<div class="alert alert-error" style="margin-bottom:14px">{form.error}</div>
				{/if}
				<form
					method="POST"
					action="?/edit_store"
					use:enhance={() => {
						saving = true;
						return ({ update }) => {
							saving = false;
							update().then(() => { if (!form?.error) editing = false; });
						};
					}}
				>
					<div class="form-grid">
						<div class="form-group full">
							<label for="name">Store name *</label>
							<input id="name" name="name" type="text" class="form-control" required
								value={form?.name ?? data.store.name} />
						</div>
						<div class="form-group">
							<label for="marketplaces">Marketplaces</label>
							{#if marketplaceOptions.length > 0}
								<!-- Multi-select fed by the SF Marketplaces__c picklist. Hidden input
								     carries the ';'-joined value the action already expects. -->
								<input type="hidden" name="marketplaces" value={marketplacesValue} />
								<div class="mp-select" class:open={mpOpen}>
									<button type="button" class="form-control mp-trigger" id="marketplaces"
										on:click={() => (mpOpen = !mpOpen)} aria-haspopup="listbox" aria-expanded={mpOpen}>
										{#if selectedMarketplaces.length === 0}
											<span class="mp-placeholder">Select marketplaces…</span>
										{:else}
											<span class="mp-chips">
												{#each selectedMarketplaces as m}<span class="mp-chip">{m}</span>{/each}
											</span>
										{/if}
										<span class="mp-caret" aria-hidden="true">▾</span>
									</button>
									{#if mpOpen}
										<div class="mp-menu" role="listbox" aria-label="Marketplaces">
											{#each marketplaceOptions as opt}
												<label class="mp-opt">
													<input type="checkbox" checked={selectedMarketplaces.includes(opt)}
														on:change={() => toggleMarketplace(opt)} />
													<span>{opt}</span>
												</label>
											{/each}
										</div>
									{/if}
								</div>
							{:else}
								<!-- Fallback when SF picklist is unavailable: free-text, comma-separated. -->
								<input id="marketplaces" name="marketplaces" type="text" class="form-control"
									value={form?.marketplaces ?? (data.store.marketplaces?.split(';').join(', ') ?? '')}
									placeholder="US, UK, DE (comma-separated)" />
							{/if}
						</div>
						<div class="form-group">
							<label for="country">Country</label>
							<input id="country" name="country" type="text" class="form-control"
								value={form?.country ?? (data.store.country ?? '')} />
						</div>
						<div class="form-group">
							<label for="sellerId">Seller ID</label>
							<input id="sellerId" name="sellerId" type="text" class="form-control"
								value={form?.sellerId ?? (data.store.sellerId ?? '')} />
						</div>
						<div class="form-group">
							<label for="businessName">Legal business name</label>
							<input id="businessName" name="businessName" type="text" class="form-control"
								value={form?.businessName ?? (data.store.businessName ?? '')} />
						</div>
						<div class="form-group">
							<label for="sellerPrimaryEmail">Amazon notification email</label>
							<input id="sellerPrimaryEmail" name="sellerPrimaryEmail" type="email" class="form-control"
								value={form?.sellerPrimaryEmail ?? (data.store.sellerPrimaryEmail ?? '')} />
						</div>
						<div class="form-group">
							<label for="storeEmail">Store contact email</label>
							<input id="storeEmail" name="storeEmail" type="email" class="form-control"
								value={form?.storeEmail ?? (data.store.storeEmail ?? '')} />
						</div>
						<div class="form-group full">
							<label for="description">Description</label>
							<textarea id="description" name="description" rows="3" class="form-control"
							>{form?.description ?? (data.store.description ?? '')}</textarea>
						</div>
					</div>
					<div style="display:flex;gap:10px;margin-top:18px">
						<button type="submit" class="btn-sm btn-orange"
							style="flex:1;padding:12px;font-size:14px" disabled={saving}>
							{saving ? 'Saving…' : 'Save Changes'}
						</button>
						<button type="button" class="btn-sm btn-nav" on:click={() => (editing = false)}
							style="padding:12px 20px" disabled={saving}>Cancel</button>
					</div>
				</form>
			</div>
		</div>
	</div>
{/if}

<style>
	.store-tabs { display: flex; gap: 4px; }
	.store-tabs button { background: none; border: none; border-bottom: 2px solid transparent; padding: 4px 10px 8px; font: inherit; font-size: 15px; font-weight: 700; color: var(--grey-text); cursor: pointer; }
	.store-tabs button.on { color: var(--navy); border-bottom-color: var(--orange); }
	.store-tabs span { margin-left: 5px; font-size: 11px; background: #EEF2F8; border-radius: 99px; padding: 1px 7px; }
	.sub-line { font-size: 11px; color: var(--grey-text); }
	.chip-s { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
	.pay-note { font-size: 12px; color: var(--grey-text); margin: 12px 0 0; }
	.muted-sm { font-size: 11px; font-weight: 500; color: var(--grey-text); }
	.hero {
		background: white; border: 1px solid var(--grey-line); border-radius: 12px;
		padding: 20px 22px; display: flex; gap: 20px; align-items: center;
		justify-content: space-between; margin-bottom: 16px;
	}
	.hero-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
	.hero-title { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
	.hero-title h1 { margin: 0; font-size: 22px; font-weight: 800; color: var(--navy); }
	.hero-sub { font-size: 13px; color: var(--grey-text); }
	.hero-rev { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; flex: 0 0 auto; }
	.rev-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); }
	.rev-amount { font-size: 26px; font-weight: 800; color: var(--navy); line-height: 1.2; }
	.rev-sub { font-size: 11px; color: var(--grey-text); }

	.detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; margin-bottom: 20px; align-items: stretch; }
	.card.tall { display: flex; flex-direction: column; max-height: 520px; margin: 0; }
	.docs-scroll { flex: 1; min-height: 0; overflow-y: auto; }
	.rec-list { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; }
	.rec {
		display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; text-align: left;
		border-radius: 10px; border: 1px solid var(--grey-line); background: white; cursor: pointer;
		font: inherit; color: inherit; transition: border-color .2s;
	}
	.rec:hover { border-color: var(--orange); }
	.rec-icon { width: 36px; height: 36px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--navy-dark); border-radius: 9px; }
	.rec-icon img { width: 18px; height: 18px; object-fit: contain; }
	.rec-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.rec-name { font-weight: 700; color: var(--navy); font-size: 14px; }
	.rec-desc { font-size: 12px; color: var(--grey-text); word-break: break-word; }

	.rec-overlay { position: fixed; inset: 0; margin-left: 72px; background: #F6F8FB; z-index: 900; display: flex; flex-direction: column; }
	.ov-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 26px; background: white; border-bottom: 1px solid var(--grey-line); }
	.ov-head h2 { margin: 4px 0 0; font-size: 17px; font-weight: 800; color: var(--navy); }
	.ov-crumbs { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--grey-text); }
	.ov-crumbs .link { background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
	.ov-crumbs .link:hover { text-decoration: underline; color: var(--navy); }
	.ov-crumbs .cur { color: var(--navy); font-weight: 600; }
	.ov-x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); }
	.ov-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 20px; padding: 20px 26px; }
	aside { background: white; border: 1px solid var(--grey-line); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 6px; align-self: start; }
	.aside-head { font-size: 12px; font-weight: 700; color: var(--navy); padding: 2px 4px 6px; }
	.aside-item { text-align: left; padding: 9px 10px; border-radius: 8px; border: 1px solid var(--grey-line); background: white; font: inherit; font-size: 13px; font-weight: 600; color: var(--navy); cursor: pointer; }
	.aside-item:hover { border-color: var(--orange); }
	.aside-item.active { border-color: var(--navy); background: #F6F8FB; }
	.ov-panel { background: white; border: 1px solid var(--grey-line); border-radius: 12px; padding: 20px 22px; overflow-y: auto; min-width: 0; }
	.ov-panel-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--grey-line); }
	.ov-kind { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--grey-text); }
	.ov-name { font-size: 19px; font-weight: 800; color: var(--navy); }
	.ov-actions { display: flex; gap: 8px; align-items: center; }
	.ov-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
	.ov-fields > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.ov-fields > .full { grid-column: 1 / -1; }
	.ov-fields span { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--grey-text); }
	.ov-fields strong { font-size: 14px; font-weight: 500; word-break: break-word; }
	.ov-fields strong.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
	@media (max-width: 960px) {
		.detail-grid, .ov-body { grid-template-columns: 1fr; }
		.hero { flex-direction: column; align-items: flex-start; }
		.hero-rev { align-items: flex-start; }
	}
	:global(:root) { --orange-dk: #c47a00; }
	.file-link {
		background: none;
		border: none;
		padding: 0;
		color: var(--orange, #ea580c);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.file-icn { width: 22px; height: 22px; object-fit: contain; display: block; }

	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }

	/* ── Cards / grid ────────────────────────────────────────── */
	.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
	.card {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 18px 20px;
	}
	.card-title {
		display: flex; align-items: center; gap: 10px; justify-content: space-between;
		font-size: 14px; font-weight: 700; color: var(--navy);
		margin-bottom: 14px; padding-bottom: 10px;
		border-bottom: 1px solid var(--grey-line);
	}
	.sub-section { margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--grey-line); }
	.sub-title {
		font-size: 12px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text); margin-bottom: 10px;
	}

	/* ── Fields ──────────────────────────────────────────────── */
	.fields-2col { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 20px; }
	.field-block { margin-bottom: 0; min-width: 0; }
	.field-label {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text); margin-bottom: 3px;
	}
	.field-value { font-size: 14px; font-weight: 500; word-break: break-word; }
	.field-value.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
	}
	.field-value.prose { white-space: pre-wrap; line-height: 1.5; }

	/* ── Record links (Account / Plan) — plain links, matches the payment detail page ── */
	.field-value a { color: var(--orange); text-decoration: none; }
	.field-value a:hover { text-decoration: underline; }

	/* ── Current Plan banner — sits atop Financial Overview, links to plan page ── */
	.monitoring-banner {
		display: flex; align-items: center; gap: 10px;
		background: #fff8ee; border: 1px solid rgba(232,137,26,.25);
		border-radius: var(--radius); padding: 10px 14px; margin-bottom: 12px;
		text-decoration: none; transition: background .15s ease;
	}
	.monitoring-banner:hover { background: #ffefd6; }
	.mb-label {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text);
	}
	.mb-arrow { margin-left: auto; font-size: 12px; font-weight: 700; color: var(--orange, #ea580c); }

	.poc-form {
		display: flex; gap: 10px; align-items: center; margin-top: 4px;
	}
	.poc-select { flex: 1; min-width: 0; }
	.poc-hint {
		font-size: 12px; color: var(--grey-text); margin: 8px 0 0;
	}
	.error-text { color: #b91c1c; font-size: 12px; }

	.sf-id { font-size: 11px; color: var(--grey-text); font-family: ui-monospace, monospace; font-weight: 500; }
	.sf-id code { background: #f3f4f6; padding: 1px 6px; border-radius: 4px; }

	/* ── Badges (mockup) ─────────────────────────────────────── */
	.badge {
		display: inline-block; padding: 3px 10px;
		font-size: 11px; font-weight: 700; border-radius: 12px;
	}
	.badge-orange { background: #fff1de; color: #b45309; }
	.badge-blue   { background: #dbeafe; color: #1d4ed8; }
	.badge-yellow { background: #fef3c7; color: #92400e; }
	.badge-green  { background: #d1fae5; color: #047857; }
	.badge-red    { background: #fee2e2; color: #b91c1c; }
	.badge-grey   { background: #e5e7eb; color: #374151; }
	.link-badge { border: none; cursor: pointer; }
	.link-badge:hover { background: #d1d5db; }

	/* ── Health bar (mockup) ─────────────────────────────────── */
	.health-bar {
		height: 6px; border-radius: 3px; background: var(--grey-line);
		overflow: hidden; margin: 10px 0 6px;
	}
	.health-fill { height: 100%; border-radius: 3px; transition: width .5s; }
	.h-good { background: #10b981; }
	.h-warn { background: #f59e0b; }
	.h-crit { background: #ef4444; }

	/* ── Financial card ──────────────────────────────────────── */
	.fin-card {
		background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
		border-radius: var(--radius); padding: 18px;
		color: white;
	}
	.fin-label { font-size: 11px; color: rgba(255,255,255,.55); margin-bottom: 4px; }
	.fin-amount { font-size: 30px; font-weight: 800; color: var(--orange); }
	.fin-sub { font-size: 11px; color: rgba(255,255,255,.4); margin-top: 3px; }
	.fin-row {
		display: flex; gap: 14px; margin-top: 12px; padding-top: 12px;
		border-top: 1px solid rgba(255,255,255,.1);
	}
	.fin-item { flex: 1; text-align: center; }
	.fin-item-val { font-size: 20px; font-weight: 800; }
	.fin-item-lbl {
		font-size: 10px; color: rgba(255,255,255,.45); text-transform: uppercase;
		letter-spacing: .04em; margin-top: 2px;
	}

	/* ── Quick filter pills (mockup) ─────────────────────────── */
	.qf-row { display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; }
	.qf {
		padding: 5px 14px; border-radius: 20px; font-size: 12px; font-weight: 600;
		cursor: pointer; border: 1.5px solid var(--grey-line); background: white;
		color: var(--grey-text); transition: all .2s;
	}
	.qf:hover { background: var(--navy); color: white; border-color: var(--navy); }
	.qf.active {
		background: var(--navy); color: white; border-color: var(--navy);
	}

	/* ── Data table (mockup) ─────────────────────────────────── */
	.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
	.data-table thead th {
		text-align: left; padding: 10px 14px; font-size: 11px;
		font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
		color: var(--grey-text); border-bottom: 1px solid var(--grey-line);
		background: #fafafa;
	}
	.data-table tbody tr {
		cursor: pointer; transition: background-color .12s;
		border-bottom: 1px solid var(--grey-line);
	}
	.data-table tbody tr:last-child { border-bottom: none; }
	.data-table tbody tr:hover { background: #fafafa; }
	.data-table tbody tr.row-waiting { border-left: 3px solid #b91c1c; background: #fef2f2; }
	.data-table tbody tr.row-waiting:hover { background: #fee2e2; }
	.data-table td { padding: 12px 14px; vertical-align: middle; }

	/* ── Documents (doc-item, mockup) ────────────────────────── */
	.doc-item {
		display: flex; align-items: center; gap: 10px;
		padding: 10px 12px; border: 1px solid var(--grey-line);
		border-radius: 9px; margin-bottom: 8px;
		transition: all .2s;
	}
	.doc-item:hover { border-color: var(--orange); background: #fff5ec; }
	.doc-item:last-child { margin-bottom: 0; }
	.doc-icon { font-size: 22px; flex-shrink: 0; }
	.doc-info { flex: 1; min-width: 0; }
	.doc-name { font-size: 13px; font-weight: 600; }
	.doc-name a { color: var(--navy); text-decoration: none; }
	.doc-name a:hover { color: var(--orange); }
	.doc-meta { font-size: 11px; color: var(--grey-text); }

	/* ── Buttons (mockup-style btn-sm) ───────────────────────── */
	.btn-sm {
		padding: 5px 12px; font-size: 12px; font-weight: 600;
		border-radius: 7px; border: 1px solid transparent; cursor: pointer;
		text-decoration: none; display: inline-block;
	}
	.btn-orange { background: var(--orange); color: white; border-color: var(--orange); }
	.btn-orange:hover:not(:disabled) { background: var(--orange-dk); }
	.btn-orange:disabled { opacity: .55; cursor: not-allowed; }
	.btn-nav { background: white; color: var(--navy); border-color: var(--grey-line); }
	.btn-nav:hover:not(:disabled) { background: #f3f4f6; }

	/* ── Alerts (mockup) ─────────────────────────────────────── */
	.alert {
		border-radius: 9px; padding: 12px 16px; font-size: 13px;
	}
	.alert-info { background: #dbeafe; border: 1px solid #93c5fd; color: #1e40af; }
	.alert-warn { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; }
	.alert-success { background: #d1fae5; border: 1px solid #86efac; color: #166534; }
	.alert-error { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; }
	.no-services-banner {
		display: flex; align-items: center; justify-content: space-between;
		gap: 14px; flex-wrap: wrap;
	}
	.no-services-actions { display: flex; gap: 8px; flex-shrink: 0; }

	/* ── Modal (mockup) ──────────────────────────────────────── */
	.modal-overlay {
		display: none; position: fixed; inset: 0;
		background: rgba(17, 29, 51, .6); backdrop-filter: blur(4px);
		z-index: 1000; align-items: center; justify-content: center; padding: 24px;
	}
	.modal-overlay.open { display: flex; }
	.modal-box {
		background: white; border-radius: 18px;
		width: 100%; max-height: 90vh; overflow-y: auto;
		box-shadow: 0 24px 80px rgba(0,0,0,.3);
		animation: mIn .2s ease;
	}
	.modal-box.md { max-width: 600px; }
	@keyframes mIn { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: scale(1); } }
	.modal-hdr {
		padding: 20px 24px 16px; border-bottom: 1px solid var(--grey-line);
		display: flex; align-items: center; justify-content: space-between;
	}
	.modal-hdr h3 { font-size: 16px; font-weight: 700; margin: 0; }
	.modal-x {
		background: #f3f4f6; border: none; width: 28px; height: 28px;
		border-radius: 50%; font-size: 15px; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
	}
	.modal-x:hover { background: var(--grey-line); }
	.modal-body { padding: 22px 24px; }

	.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
	.form-grid .full { grid-column: 1 / -1; }

	/* ── Required-file slot rows ─────────────────────────────── */
	.doc-item.slot { align-items: flex-start; padding: 12px 14px; }
	.doc-item.slot .doc-name { color: var(--navy); font-weight: 600; }
	.doc-item.slot.slot-uploaded { background: #f0fdf4; border-color: #bbf7d0; }
	.doc-item.slot.slot-uploaded:hover { background: #dcfce7; }
	.doc-desc {
		font-size: 12px; color: var(--grey-text); line-height: 1.45;
		margin-top: 2px;
	}
	.doc-meta a { color: var(--orange); text-decoration: none; }
	.doc-meta a:hover { text-decoration: underline; }
	.doc-meta.mono {
		font-family: ui-monospace, monospace; font-size: 11px; word-break: break-all;
	}
	.slot-right {
		display: flex; flex-direction: column; align-items: flex-end;
		gap: 6px; flex-shrink: 0; margin-left: 8px;
	}
	.link-x {
		background: none; border: none; color: var(--grey-text);
		font-size: 14px; cursor: pointer; padding: 2px 6px;
	}
	.link-x:hover { color: #b91c1c; }

	/* ── Slot upload modal extras (mirror case detail) ─────── */
	.slot-context {
		background: #f9fafb; border: 1px solid var(--grey-line);
		border-radius: 10px; padding: 12px 14px; margin-bottom: 16px;
	}
	.slot-context-label {
		font-size: 10px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text); margin-bottom: 4px;
	}
	.slot-context-name { font-size: 14px; font-weight: 600; color: var(--navy); }

	.upload-modal-zone {
		border: 2px dashed var(--grey-line); border-radius: 12px;
		padding: 32px 20px; text-align: center; cursor: pointer;
		transition: all .25s; margin-bottom: 18px;
	}
	.upload-modal-zone:hover,
	.upload-modal-zone.drag-over {
		border-color: var(--orange); background: #fff5ec;
	}
	.uz-icon {
		width: 56px; height: 56px; margin: 0 auto 12px;
		background: var(--navy-dark); border-radius: 14px;
		display: flex; align-items: center; justify-content: center;
	}
	.uz-icon img { width: 28px; height: 28px; object-fit: contain; }
	.uz-title { font-size: 15px; font-weight: 700; color: var(--navy); margin-bottom: 4px; }
	.uz-sub { font-size: 13px; color: var(--grey-text); }

	.file-type-grid {
		display: grid; grid-template-columns: repeat(3, 1fr);
		gap: 8px; margin-bottom: 18px;
	}
	.file-type-item {
		background: #f3f4f6; border-radius: 8px; padding: 9px 10px; text-align: center;
	}
	.ft-icon { height: 28px; margin-bottom: 4px; display: flex; align-items: center; justify-content: center; }
	.ft-icon img { width: 26px; height: 26px; object-fit: contain; }
	.ft-label { font-size: 11px; font-weight: 700; color: var(--navy); }
	.ft-desc { font-size: 10px; color: var(--grey-text); }

	.guidelines {
		background: #f3f4f6; border-radius: 10px;
		padding: 14px 16px; margin-bottom: 18px; font-size: 13px;
	}
	.guidelines-hdr {
		display: flex; align-items: center; gap: 8px;
		font-weight: 700; margin-bottom: 10px; color: var(--navy);
	}
	.g-badge {
		width: 28px; height: 28px; flex-shrink: 0;
		background: var(--navy-dark); border-radius: 8px;
		display: flex; align-items: center; justify-content: center;
	}
	.g-badge img { width: 16px; height: 16px; object-fit: contain; }
	.guidelines ul {
		padding-left: 16px; color: var(--grey-text); line-height: 1.9; margin: 0;
	}

	/* ── "Connected to Amazon" persistent strip ──────────────── */
	.amazon-link-strip {
		display: flex; align-items: center; gap: 14px;
		padding: 12px 16px; border-radius: 12px;
		background: linear-gradient(90deg, #232F3E 0%, #2c3a4e 100%);
		color: white;
	}
	.amazon-mark {
		display: inline-flex; align-items: center; justify-content: center;
		width: 32px; height: 32px; border-radius: 50%;
		background: #FF9900; color: #232F3E; font-size: 16px; font-weight: 800;
		flex-shrink: 0;
	}
	.link-text { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.link-text strong { font-size: 14px; font-weight: 700; }
	.link-sub { font-size: 11px; color: rgba(255,255,255,.65); }
	.link-sub code {
		font-family: ui-monospace, monospace;
		background: rgba(255,255,255,.08); padding: 1px 6px; border-radius: 4px;
		color: white;
	}
	.amazon-link-strip .btn-nav {
		background: rgba(255,255,255,.08); color: white; border-color: rgba(255,255,255,.15);
	}
	.amazon-link-strip .btn-nav:hover { background: rgba(255,255,255,.18); }

	/* Marketplaces multi-select */
	.mp-select { position: relative; }
	.mp-trigger {
		display: flex; align-items: center; gap: 8px; width: 100%;
		text-align: left; cursor: pointer; min-height: 40px;
	}
	.mp-placeholder { color: var(--grey-text); flex: 1; }
	.mp-chips { display: flex; flex-wrap: wrap; gap: 4px; flex: 1; }
	.mp-chip {
		background: #fff1de; color: #b45309; font-size: 11px; font-weight: 700;
		padding: 2px 8px; border-radius: 10px;
	}
	.mp-caret { color: var(--grey-text); font-size: 12px; flex-shrink: 0; }
	.mp-select.open .mp-caret { transform: rotate(180deg); }
	.mp-menu {
		position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 10;
		background: white; border: 1px solid var(--grey-line); border-radius: 10px;
		box-shadow: var(--shadow-lg); max-height: 220px; overflow-y: auto; padding: 6px;
	}
	.mp-opt {
		display: flex; align-items: center; gap: 8px; padding: 7px 9px;
		border-radius: 7px; font-size: 13px; cursor: pointer;
	}
	.mp-opt:hover { background: #fafbfc; }
	.mp-opt input { accent-color: var(--orange); cursor: pointer; }
</style>
