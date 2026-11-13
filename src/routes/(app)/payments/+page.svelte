<script lang="ts">
	import Topbar from '$components/layout/Topbar.svelte';
	import { page } from '$app/stores';
	import { goto } from '$app/navigation';
	import { browser } from '$app/environment';
	import type { PageData } from './$types';

	export let data: PageData;

	type Pay = PageData['payments'][number];
	type Con = PageData['contracts'][number];

	const PS = {
		paid: { label: 'Paid', group: 'finished', bg: '#DCFCE7', fg: '#15803d', seg: '#22C55E', dateLabel: 'Paid' },
		action: { label: 'Action required', group: 'active', bg: '#FEE2E2', fg: '#b91c1c', seg: '#EF4444', dateLabel: 'Payment failed' },
		due: { label: 'Due', group: 'active', bg: '#FEF3C7', fg: '#92400e', seg: '#F59E0B', dateLabel: 'Created' },
		closed: { label: 'Closed', group: 'finished', bg: '#F1F5F9', fg: '#475569', seg: '#B8C0CC', dateLabel: 'Closed' },
		inactive: { label: 'Not Active', group: 'active', bg: '#F1F5F9', fg: '#475569', seg: '#B8C0CC', dateLabel: 'Not payable yet' },
		ready: { label: 'Ready to pay', group: 'active', bg: '#DBEAFE', fg: '#1d4ed8', seg: '#3B82F6', dateLabel: 'Ready' }
	} as const;
	const FILTERS = [['all', 'All'], ['active', 'Active'], ['finished', 'Finished']] as const;

	const look = (p: { status: keyof typeof PS }) => PS[p.status];

	const usd = (n: number) =>
		'$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
	const fmtDate = (iso: string | null | undefined) => {
		if (!iso) return '—';
		try {
			return new Date(iso.length === 10 ? iso + 'T00:00:00' : iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
		} catch { return iso; }
	};
	async function copy(t: string) {
		try { await navigator.clipboard.writeText(t); toast = `Copied ${t}`; setTimeout(() => (toast = null), 2000); } catch { /* needs user gesture */ }
	}

	let tab: 'invoices' | 'contracts' = 'invoices';
	let filter: 'all' | 'active' | 'finished' = 'all';
	let search = '';
	let conId: string | null = $page.url.searchParams.get('contract');
	let invId: string | null = null;

	// Keep ?contract=<id> in the URL in step with the open contract (shareable, back button works).
	let lastSynced: string | null = conId;
	function onUrl(q: string | null) {
		if (q === lastSynced) return;
		lastSynced = q;
		conId = q;
	}
	function onContract(id: string | null) {
		const canon = urlId(id);
		if (!browser || canon === lastSynced) return;
		lastSynced = canon;
		const u = new URL(window.location.href);
		if (canon) u.searchParams.set('contract', canon); else u.searchParams.delete('contract');
		goto(u, { keepFocus: true, noScroll: true });
	}
	$: onUrl($page.url.searchParams.get('contract'));
	$: onContract(conId);
	let toast: string | null = null;
	const q = $page.url.searchParams;
	const flash = q.get('paid') ? `Payment received — thank you. ${q.get('paid') !== '1' ? q.get('paid') + ' is now paid.' : ''}` : q.get('payment') === 'failed' ? 'The payment did not go through. You have not been charged — please try again.' : q.get('payment') === 'processing' ? 'Your payment is still processing. It will show as Paid shortly.' : null;

	$: conById = new Map(data.contracts.flatMap((c) => (c.sfdcServiceContractId ? [[c.id, c], [c.sfdcServiceContractId, c]] : [[c.id, c]]) as [string, (typeof data.contracts)[number]][]));
	// One canonical URL id per contract: its Salesforce id when it has one (same link from the dashboard).
	const urlId = (id: string | null) => (id ? conById.get(id)?.sfdcServiceContractId ?? id : id);
	// Line payments are components of the contract's First Payment, so only
	// top-level payments are invoices and count toward totals.
	$: topPays = data.payments.filter((p) => !p.isLine);
	$: svc = (c: Con) => c.name || c.lines.map((l) => l.name).join(' + ') || (c.kind === 'subscription' ? 'Subscription' : 'Service contract');
	$: conTotal = (c: Con) => (c.lines.length ? c.lines.reduce((n, l) => n + l.qty * l.unit, 0) : c.amount);

	$: paidSum = topPays.filter((p) => p.status === 'paid').reduce((n, p) => n + p.amount, 0);
	$: owedSum = topPays.filter((p) => p.status === 'due' || p.status === 'action' || p.status === 'ready').reduce((n, p) => n + p.amount, 0);
	$: deferredSum = topPays.filter((p) => p.status === 'inactive').reduce((n, p) => n + p.amount, 0);
	$: actionP = topPays.find((p) => p.status === 'action');
	$: nextDue = topPays.filter((p) => p.status === 'due' || p.status === 'ready').sort((a, b) => a.date.localeCompare(b.date))[0];

	// The list includes line payments (the parts of a deposit order); totals still use only top-level payments.
	// Click a column header to sort; click again to reverse; a third click returns to the default order.
	type SortKey = 'invoice' | 'contract' | 'store' | 'service' | 'payment' | 'amount' | 'date' | 'status';
	let sortKey: SortKey | null = null;
	let sortDir: 'asc' | 'desc' = 'asc';
	function sortBy(k: SortKey) {
		if (sortKey !== k) { sortKey = k; sortDir = k === 'amount' || k === 'date' ? 'desc' : 'asc'; }
		else if (sortDir === 'asc' && (k === 'amount' || k === 'date')) sortKey = null;
		else if (sortDir === 'asc') sortDir = 'desc';
		else if (k === 'amount' || k === 'date') sortDir = 'asc';
		else sortKey = null;
	}
	const sortValue = (p: Pay, k: SortKey): string | number => {
		const c = conById.get(p.contractId);
		switch (k) {
			case 'invoice': return p.id;
			case 'contract': return c?.ref ?? '';
			case 'store': return c?.storeName ?? '';
			case 'service': return c ? svc(c) : '';
			case 'payment': return p.kind;
			case 'amount': return p.amount;
			case 'date': return p.date;
			case 'status': return look(p).label;
		}
	};
	const arrow = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? '▲' : '▼') : '↕');
	const aria = (k: SortKey) => (sortKey === k ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none');

	$: inv = data.payments
		.filter((p) => {
			const c = conById.get(p.contractId);
			if (filter !== 'all' && PS[p.status].group !== filter) return false;
			const q = search.trim().toLowerCase();
			return !q || [p.id, c?.ref, c?.storeName, c ? svc(c) : ''].join(' ').toLowerCase().includes(q);
		})
		.sort((a, b) => {
			if (!sortKey) return PS[a.status].group === PS[b.status].group ? b.date.localeCompare(a.date) : PS[a.status].group === 'active' ? -1 : 1;
			const ka = sortValue(a, sortKey), kb = sortValue(b, sortKey);
			const r = typeof ka === 'number' && typeof kb === 'number' ? ka - kb : String(ka).localeCompare(String(kb), undefined, { numeric: true, sensitivity: 'base' });
			return (sortDir === 'asc' ? r : -r) || b.date.localeCompare(a.date);
		});
	$: count = (f: string) => data.payments.filter((p) => f === 'all' || PS[p.status].group === f).length;

	$: conPays = (c: Con) => data.payments.filter((p) => p.contractId === c.id);
	$: conTop = (c: Con) => topPays.filter((p) => p.contractId === c.id);
	$: conPaid = (c: Con) => conTop(c).filter((p) => p.status === 'paid').reduce((n, p) => n + p.amount, 0);
	function conStatus(c: Con): [string, string, string] {
		const t = conTop(c);
		if (t.some((p) => p.status === 'action')) return ['Action required', '#FEE2E2', '#b91c1c'];
		if (t.length && t.every((p) => p.status === 'paid' || p.status === 'closed') && c.endDate < new Date().toISOString().slice(0, 10)) return ['Completed', '#F1F5F9', '#475569'];
		return ['Active', '#DCFCE7', '#15803d'];
	}

	$: cd = conId ? conById.get(conId) ?? null : null;
	$: ip = invId ? data.payments.find((p) => p.id === invId) ?? null : null;
	// Stripe receipt / invoice for a paid payment — loaded when its details open; each button appears only if Stripe has that document.
	let docs: { receiptUrl: string | null; invoiceUrl: string | null } | null = null;
	let docsFor: string | null = null;
	$: if (ip && ip.status === 'paid' && docsFor !== ip.id) {
		docsFor = ip.id; docs = null;
		const key = ip.sfId ?? `local:${ip.contractId}`;
		fetch(`/api/payments/${encodeURIComponent(key)}/documents`).then((r) => (r.ok ? r.json() : null)).then((d) => { if (docsFor === ip?.id) docs = d; }).catch(() => {});
	} else if (!ip) { docsFor = null; docs = null; }
	$: ipCon = ip ? conById.get(ip.contractId) ?? null : null;
</script>

<svelte:head><title>Payments — Appeals Doctor</title></svelte:head>

<Topbar title="Payments" subtitle="Invoices and service contracts">
	<a href="/stores" class="btn btn-primary btn-sm" data-mutates>+ Buy services</a>
</Topbar>

<div class="content-area">
	{#if data.paymentsError}
		<div class="alert alert-error" style="margin-bottom:14px">Could not load payments from Salesforce — showing what's on record locally.</div>
	{/if}
	{#if actionP}
		<div class="action-banner">
			<span><strong>{usd(actionP.amount)} payment for {conById.get(actionP.contractId)?.ref} failed.</strong> Please review it so your case isn't delayed.</span>
			<button type="button" class="btn btn-primary btn-sm" on:click={() => (invId = actionP.id)}>Review →</button>
		</div>
	{/if}

	<section class="hero">
		<div class="hero-main">
			<h1>{data.accountName ?? 'Your account'}</h1>
			<div class="hero-sub">Receipts to {data.receiptEmail ?? '—'} · deposit services are paid in parts</div>
		</div>
		<div class="hero-stats">
			<div class="hstat">
				<span class="hstat-label">Paid to date</span>
				<span class="hstat-val">{usd(paidSum)}</span>
				<span class="hstat-sub">{topPays.filter((p) => p.status === 'paid').length} payments · {data.contracts.length} contracts</span>
			</div>
			<div class="hstat">
				<span class="hstat-label">Outstanding</span>
				<span class="hstat-val">{usd(owedSum)}</span>
				<span class="hstat-sub">{nextDue ? `Next ${usd(nextDue.amount)} · ${fmtDate(nextDue.date)}` : 'Nothing due today'}{deferredSum ? ` · ${usd(deferredSum)} not active yet` : ''}</span>
			</div>
		</div>
	</section>

	{#if flash}<div class="adm-flash ok" role="status">{flash}</div>{/if}
	{#if data.payments.some((p) => p.status === 'inactive' || p.status === 'ready')}
		<div class="split-note" role="note">
			<strong>Some of your services are paid in several payments.</strong>
			You paid the full price or the deposit when you ordered. The balance for each deposit service is a separate payment that is paid
			<strong>separately, when that case is completed</strong>. It shows as <strong>Not Active</strong> until then, and as <strong>Ready to pay</strong>
			with a Pay button once it can be paid.
		</div>
	{/if}

	<div class="panel">
		<nav class="tabs">
			<button type="button" class:active={tab === 'invoices'} on:click={() => (tab = 'invoices')}>Invoices <span>{data.payments.length}</span></button>
			<button type="button" class:active={tab === 'contracts'} on:click={() => (tab = 'contracts')}>Contracts <span>{data.contracts.length}</span></button>
		</nav>

		{#if tab === 'invoices'}
			<div class="inv-bar">
				<div class="pills">
					{#each FILTERS as [k, label]}
						<button type="button" class="pill" class:active={filter === k} on:click={() => (filter = k)}>{label} <span>{count(k)}</span></button>
					{/each}
				</div>
				<input type="search" class="form-control search" placeholder="Search invoice, contract or store…" aria-label="Search invoices" bind:value={search} />
			</div>
			<div class="table">
				<div class="tr th" role="row">
					{#each [['invoice', 'Invoice'], ['contract', 'Contract'], ['store', 'Store'], ['service', 'Service'], ['payment', 'Payment'], ['amount', 'Amount'], ['date', 'Date'], ['status', 'Status']] as [k, label]}
						<button type="button" class="sort" class:r={k === 'amount'} class:on={sortKey === k} aria-sort={aria(k as SortKey)} title="Sort by {label.toLowerCase()}" on:click={() => sortBy(k as SortKey)}>{label}<span class="arrow">{arrow(k as SortKey)}</span></button>
					{/each}
				</div>
				{#each inv as p (p.id + p.contractId)}
					{@const c = conById.get(p.contractId)}
					{@const ps = look(p)}
					<div class="tr row" role="button" tabindex="0" on:click={() => (invId = p.id)} on:keydown={(e) => e.key === 'Enter' && (invId = p.id)}>
						<span class="mono">{p.id}</span>
						<button type="button" class="link mono" on:click|stopPropagation={() => (conId = p.contractId)}>{c?.ref ?? '—'}</button>
						<span class="store">{c?.storeName ?? '—'}</span>
						<div class="strong">{c ? svc(c) : '—'}</div>
						<span>{p.kind}</span>
						<strong class="r">{usd(p.amount)}</strong>
						<div><div>{fmtDate(p.date)}</div><div class="sub">{ps.dateLabel}</div></div>
						<span class="statuscell"><span class="chip" style="background:{ps.bg};color:{ps.fg}">{ps.label}</span>
							{#if p.status === 'ready' && p.sfId}<a class="btn btn-primary btn-sm" href={`/payments/pay/${p.sfId}`} on:click|stopPropagation>Pay</a>{/if}</span>
					</div>
				{/each}
				{#if inv.length === 0}
					<div class="empty">{search ? `No invoices match "${search}".` : 'No invoices in this view.'}</div>
				{/if}
			</div>
		{:else}
			<div class="con-list">
				{#each data.contracts as c (c.id)}
					{@const st = conStatus(c)}
					<div class="con" role="button" tabindex="0" on:click={() => (conId = c.id)} on:keydown={(e) => e.key === 'Enter' && (conId = c.id)}>
						<span class="con-icon"><img src="/icons/payment.png" alt="" /></span>
						<div class="con-main">
							<div class="con-top"><span class="mono strong">{c.ref}</span><span class="chip" style="background:{st[1]};color:{st[2]}">{st[0]}</span></div>
							<div class="sub">{c.storeName ?? '—'} · {svc(c)}</div>
						</div>
						<div class="con-term"><div class="sub">Term</div><div>{fmtDate(c.startDate)} → {fmtDate(c.endDate)}</div></div>
						<div class="con-pay">
							<div class="segs">{#each conTop(c) as p}<span style="background:{look(p).seg}" title="{p.kind} — {look(p).label}"></span>{/each}</div>
							<span class="sub">{conTop(c).filter((p) => p.status === 'paid').length} of {conTop(c).length} paid</span>
						</div>
						<div class="con-total"><strong>{usd(conTotal(c))}</strong><div class="sub">{usd(conPaid(c))} paid</div></div>
					</div>
				{:else}
					<div class="empty">No service contracts yet. Buy a service from one of your stores to get started.</div>
				{/each}
			</div>
		{/if}
	</div>
</div>

<!-- ─── Contract detail overlay ────────────────────────────────────── -->
{#if cd}
	{@const st = conStatus(cd)}
	<div class="overlay" role="dialog" aria-modal="true" aria-label="Contract detail">
		<div class="ov-head">
			<div>
				<nav class="ov-crumbs" aria-label="Breadcrumb">
					<button type="button" class="link" on:click={() => (conId = null)}>Payments</button><span>/</span>
					<button type="button" class="link" on:click={() => { conId = null; tab = 'contracts'; }}>Contracts</button><span>/</span>
					<span class="cur">{cd.ref}</span>
				</nav>
				<h2>{svc(cd)}</h2>
			</div>
			<button type="button" class="ov-x" aria-label="Close" title="Close" on:click={() => (conId = null)}>✕</button>
		</div>
		<div class="ov-scroll">
			<section class="box">
				<div class="box-head">
					<div>
						<div class="kind">Service contract</div>
						<div class="box-title"><span class="mono">{cd.ref}</span><span class="chip" style="background:{st[1]};color:{st[2]}">{st[0]}</span></div>
						<div class="sub">{cd.storeName ?? '—'} · {cd.kind === 'subscription' ? 'Subscription' : conTop(cd).length > 1 ? 'Paid in parts' : 'Paid in full'}</div>
					</div>
					<div class="right">
						<div class="big">{usd(conTotal(cd))}</div>
						<div class="sub">{usd(conPaid(cd))} paid · {usd(Math.max(conTotal(cd) - conPaid(cd), 0))} remaining</div>
						<div class="segs end">{#each conTop(cd) as p}<span style="background:{look(p).seg}" title="{p.kind} — {look(p).label}"></span>{/each}</div>
					</div>
				</div>
				<div class="fields">
					<div><span>Store</span><strong>{cd.storeName ?? '—'}</strong></div>
					<div><span>Term</span><strong>{fmtDate(cd.startDate)} → {fmtDate(cd.endDate)} · {cd.termMonths} months</strong></div>
					{#if cd.stripePaymentIntentId}<div><span>Stripe payment</span><button type="button" class="copy" title="Click to copy" on:click={() => copy(cd.stripePaymentIntentId)}>{cd.stripePaymentIntentId}</button></div>{/if}
					<div><span>Salesforce contract</span>
						{#if cd.sfdcServiceContractId}<button type="button" class="copy" title="Click to copy" on:click={() => copy(cd.sfdcServiceContractId ?? '')}>{cd.sfdcServiceContractId}</button>{:else}<strong>—</strong>{/if}</div>
					<div><span>Sync status</span><strong>{cd.syncStatus === 'synced' ? 'In Salesforce' : cd.syncStatus === 'failed' ? 'Sync failed' : 'Pending'}</strong></div>
					<div><span>Purchased</span><strong>{fmtDate(cd.paidAt)}</strong></div>
				</div>
			</section>

			<section class="box">
				<div class="box-sec">Products purchased <span class="sub">{cd.lines.length} product{cd.lines.length === 1 ? '' : 's'} · {cd.lines.reduce((n, l) => n + l.qty, 0)} unit{cd.lines.reduce((n, l) => n + l.qty, 0) === 1 ? '' : 's'}</span></div>
				<div class="ltr lth"><span>Product</span><span>Category</span><span class="r">Qty</span><span class="r">Unit price</span><span class="r">Subtotal</span></div>
				{#each cd.lines as l}
					<div class="ltr"><div><div class="strong">{l.name}</div><div class="sub">{l.desc ?? ''}</div></div><span>{l.category ?? '—'}</span><span class="r">{l.qty}</span><span class="r">{usd(l.unit)}</span><strong class="r">{usd(l.qty * l.unit)}</strong></div>
				{/each}
				<div class="ltr total"><span>Contract total</span><strong class="r">{usd(conTotal(cd))}</strong></div>
			</section>

			<section class="box">
				<div class="box-sec">Payments <span class="sub">{conTop(cd).filter((p) => p.status === 'paid').length} of {conTop(cd).length} paid</span></div>
				<div class="pay-list">
					{#each conPays(cd) as p, k (p.id + k)}
						{@const ps = look(p)}
						<div class="pay" class:line={p.isLine} class:bad={p.status === 'action'} role="button" tabindex="0" on:click={() => (invId = p.id)} on:keydown={(e) => e.key === 'Enter' && (invId = p.id)}>
							<span class="dot" style="background:{ps.seg}"></span>
							<div class="pay-main"><div class="strong">{p.kind}</div><div class="sub">{p.id} · {ps.dateLabel} {fmtDate(p.date)}</div></div>
							<strong>{usd(p.amount)}</strong>
							<span class="chip" style="background:{ps.bg};color:{ps.fg}">{ps.label}</span>
							{#if p.status === 'ready' && p.sfId}<a class="btn btn-primary btn-sm" href={`/payments/pay/${p.sfId}`} on:click|stopPropagation>Pay</a>{/if}
						</div>
					{/each}
				</div>
			</section>
		</div>
	</div>
{/if}

<!-- ─── Invoice modal ──────────────────────────────────────────────── -->
{#if ip}
	{@const ps = look(ip)}
	<div class="backdrop" role="presentation" on:click={() => (invId = null)}>
		<div class="modal" role="dialog" aria-modal="true" aria-label="Invoice" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
			<header><h3>Invoice {ip.id}</h3><button type="button" class="ov-x" aria-label="Close" on:click={() => (invId = null)}>✕</button></header>
			<div class="modal-body">
				<div class="inv-top">
					<div><div class="sub">{ip.kind} · {ipCon ? svc(ipCon) : ''}</div><div class="big">{usd(ip.amount)}</div></div>
					<span class="chip" style="background:{ps.bg};color:{ps.fg}">{ps.label}</span>
				</div>
				{#if ip.status === 'action'}
					<div class="note bad">This payment failed. Our team will reach out, or contact support to retry it.</div>
				{:else if ip.status === 'due'}
					<div class="note info">This payment is {ip.statusRaw.toLowerCase()} in Salesforce and will be collected per your payment plan.</div>
				{/if}
				<div class="fields">
					<div><span>Contract</span><strong>{ipCon?.ref ?? '—'}</strong></div>
					<div><span>Store</span><strong>{ipCon?.storeName ?? '—'}</strong></div>
					<div><span>{ps.dateLabel}</span><strong>{fmtDate(ip.date)}</strong></div>
					<div><span>Receipt email</span><strong>{data.receiptEmail ?? '—'}</strong></div>
					<div><span>Stripe payment</span>{#if ip.pi}<span class="mono">{ip.pi}</span>{:else}<strong>—</strong>{/if}</div>
				</div>
			</div>
			<footer>
				{#if ip.status === 'ready' && ip.sfId}<a class="btn btn-primary btn-sm" href={`/payments/pay/${ip.sfId}`}>Pay {usd(ip.amount)}</a>{/if}
				{#if docs?.receiptUrl}<a class="btn btn-outline btn-sm" href={docs.receiptUrl} target="_blank" rel="noopener">⬇ Download receipt</a>{/if}
				{#if docs?.invoiceUrl}<a class="btn btn-outline btn-sm" href={docs.invoiceUrl} target="_blank" rel="noopener">⬇ Download invoice</a>{/if}
				{#if ipCon}<button type="button" class="btn btn-outline btn-sm" on:click={() => { invId = null; conId = ipCon.id; }}>View contract {ipCon.ref}</button>{/if}
				<button type="button" class="btn btn-outline btn-sm" on:click={() => (invId = null)}>Close</button>
			</footer>
		</div>
	</div>
{/if}

{#if toast}<div class="toast">{toast}</div>{/if}

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 14px 26px 22px; }
	.sub { font-size: 11px; color: var(--grey-text); margin-top: 1px; }
	.strong { font-weight: 700; color: var(--navy); }
	.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; font-weight: 600; color: var(--navy); }
	.r { text-align: right; }
	.chip { display: inline-block; padding: 3px 10px; font-size: 11px; font-weight: 700; border-radius: 12px; white-space: nowrap; }
	.link { background: none; border: none; padding: 0; font: inherit; color: var(--grey-text); cursor: pointer; text-align: left; }
	.link:hover { color: var(--orange); text-decoration: underline; }
	.empty { padding: 28px; text-align: center; font-size: 13px; color: var(--grey-text); }

	.action-banner {
		display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-bottom: 14px;
		background: #FEF2F2; border: 1px solid #fca5a5; color: #b91c1c; border-radius: 9px; padding: 12px 16px; font-size: 13px;
	}
	.hero { background: white; border: 1px solid var(--grey-line); border-radius: 12px; padding: 20px 22px; display: flex; gap: 20px; align-items: center; justify-content: space-between; margin-bottom: 16px; }
	.hero-main h1 { margin: 0 0 6px; font-size: 22px; font-weight: 800; color: var(--navy); }
	.hero-sub { font-size: 13px; color: var(--grey-text); }
	.hero-stats { display: flex; gap: 28px; flex: 0 0 auto; }
	.hstat { display: flex; flex-direction: column; align-items: flex-end; gap: 1px; }
	.hstat-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); }
	.hstat-val { font-size: 24px; font-weight: 800; color: var(--navy); line-height: 1.2; }
	.hstat-sub { font-size: 11px; color: var(--grey-text); }

	.split-note { background: #EFF6FF; border: 1px solid #BFDBFE; color: #1e3a8a; border-radius: 10px; padding: 12px 16px; font-size: 13px; line-height: 1.5; margin-bottom: 16px; }
	.statuscell { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.adm-flash { background: #d1fae5; border: 1px solid #86efac; color: #166534; border-radius: 10px; padding: 12px 16px; font-size: 13px; margin-bottom: 16px; }
	.panel { background: white; border: 1px solid var(--grey-line); border-radius: 12px; overflow: hidden; }
	.tabs { display: flex; gap: 6px; padding: 0 18px; border-bottom: 1px solid var(--grey-line); }
	.tabs button { background: none; border: none; border-bottom: 2px solid transparent; padding: 14px 10px; font: inherit; font-size: 14px; font-weight: 700; color: var(--grey-text); cursor: pointer; margin-bottom: -1px; }
	.tabs button.active { color: var(--navy); border-bottom-color: var(--navy); }
	.tabs button span { margin-left: 6px; font-size: 11px; background: #EEF2F8; border-radius: 99px; padding: 1px 7px; }
	.inv-bar { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 12px 18px; flex-wrap: wrap; }
	.pills { display: flex; gap: 6px; }
	.pill { background: white; border: 1px solid var(--grey-line); border-radius: 99px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer; }
	.pill.active { background: var(--navy); border-color: var(--navy); color: white; }
	.pill span { opacity: .7; margin-left: 3px; }
	.search { max-width: 320px; }

	.tr { display: grid; grid-template-columns: 1.05fr .8fr 1.1fr 1.4fr .9fr .7fr .85fr .95fr; gap: 12px; align-items: center; padding: 11px 18px; font-size: 13px; border-top: 1px solid var(--grey-line); }
	.sort { background: none; border: none; padding: 0; font: inherit; text-transform: inherit; letter-spacing: inherit; font-weight: inherit; color: inherit; cursor: pointer; text-align: left; display: inline-flex; align-items: center; gap: 4px; }
	.sort.r { justify-content: flex-end; text-align: right; }
	.sort:hover, .sort.on { color: var(--navy); }
	.arrow { font-size: 9px; opacity: .8; }
	.store { font-weight: 600; color: var(--navy); }
	.tr.th { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); background: #fafafa; }
	.tr.row { cursor: pointer; }
	.tr.row:hover { background: #F6F8FB; }

	.con-list { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px; }
	.con { display: flex; align-items: center; gap: 16px; padding: 14px 16px; cursor: pointer; background: white; border: 1px solid var(--grey-line); border-radius: 12px; transition: border-color .2s; }
	.con:hover { border-color: var(--orange); }
	.con-icon { width: 36px; height: 36px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; background: var(--navy-dark); border-radius: 9px; }
	.con-icon img { width: 18px; height: 18px; object-fit: contain; }
	.con-main { flex: 1; min-width: 0; }
	.con-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.con-term { font-size: 13px; color: var(--navy); }
	.con-pay { display: flex; flex-direction: column; gap: 3px; min-width: 90px; }
	.con-total { text-align: right; font-size: 15px; color: var(--navy); min-width: 90px; }
	.segs { display: flex; gap: 3px; }
	.segs.end { justify-content: flex-end; margin-top: 6px; }
	.segs span { width: 22px; height: 6px; border-radius: 3px; }

	.overlay { position: fixed; inset: 0; margin-left: 72px; background: #F6F8FB; z-index: 900; display: flex; flex-direction: column; }
	.ov-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 26px; background: white; border-bottom: 1px solid var(--grey-line); }
	.ov-head h2 { margin: 4px 0 0; font-size: 17px; font-weight: 800; color: var(--navy); }
	.ov-crumbs { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--grey-text); }
	.ov-crumbs .cur { color: var(--navy); font-weight: 600; }
	.ov-x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); line-height: 1; }
	.ov-scroll { flex: 1; overflow-y: auto; padding: 20px 26px 40px; display: flex; flex-direction: column; gap: 16px; }
	.box { background: white; border: 1px solid var(--grey-line); border-radius: 12px; padding: 18px 20px; }
	.box-head { display: flex; justify-content: space-between; gap: 16px; padding-bottom: 14px; margin-bottom: 14px; border-bottom: 1px solid var(--grey-line); }
	.box-title { display: flex; align-items: center; gap: 8px; font-size: 18px; margin: 2px 0; }
	.kind { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--grey-text); }
	.right { text-align: right; }
	.big { font-size: 24px; font-weight: 800; color: var(--navy); }
	.box-sec { display: flex; justify-content: space-between; align-items: center; font-size: 14px; font-weight: 700; color: var(--navy); margin-bottom: 10px; }
	.fields { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px 24px; }
	.fields > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.fields span:not(.mono):not(.chip) { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--grey-text); }
	.fields strong { font-size: 14px; font-weight: 500; word-break: break-word; }
	.copy { background: none; border: none; padding: 0; text-align: left; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--navy); cursor: pointer; word-break: break-all; }
	.copy:hover { text-decoration: underline; }
	.ltr { display: grid; grid-template-columns: 2fr 1fr .5fr .8fr .8fr; gap: 12px; align-items: center; padding: 10px 0; font-size: 13px; border-top: 1px solid var(--grey-line); }
	.ltr.lth { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); border-top: none; padding-top: 0; }
	.ltr.total { grid-template-columns: 1fr auto; font-weight: 700; }
	.pay-list { display: flex; flex-direction: column; gap: 8px; }
	.pay { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border: 1px solid var(--grey-line); border-radius: 10px; cursor: pointer; }
	.pay:hover { border-color: var(--orange); }
	.pay.bad { background: #FEF2F2; border-color: #fca5a5; }
	.pay.line { margin-left: 22px; background: #fafafa; }
	.pay-main { flex: 1; min-width: 0; }
	.dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }

	.backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.55); z-index: 1000; display: flex; align-items: center; justify-content: center; padding: 24px; }
	.modal { background: white; border-radius: 12px; width: min(560px, 100%); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.25); }
	.modal header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--grey-line); }
	.modal h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy); }
	.modal-body { padding: 18px; overflow: auto; }
	.modal footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--grey-line); }
	.modal .fields { grid-template-columns: 1fr 1fr; }
	.inv-top { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 14px; }
	.note { border-radius: 9px; padding: 10px 14px; font-size: 13px; margin-bottom: 14px; }
	.note.bad { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; }
	.note.info { background: #EFF6FF; border: 1px solid #BFDBFE; color: #1d4ed8; }
	.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: var(--navy); color: white; padding: 8px 16px; border-radius: 8px; font-size: 13px; z-index: 1100; }

	@media (max-width: 960px) {
		.hero { flex-direction: column; align-items: flex-start; }
		.tr { grid-template-columns: 1fr 1fr; }
		.tr.th { display: none; }
		.fields { grid-template-columns: 1fr 1fr; }
		.con { flex-wrap: wrap; }
	}
</style>
