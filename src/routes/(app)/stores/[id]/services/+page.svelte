<script lang="ts">
	import { goto } from '$app/navigation';
	import Topbar from '$components/layout/Topbar.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	// "Recurring products" tab — only offered when the SFDC_PRICE_RECURRING price book has products.
	$: hasRecurring = data.recurringCategories.some((c) => c.products.length > 0);
	let tab: 'services' | 'recurring' = 'services';
	$: isRecurring = tab === 'recurring' && hasRecurring;
	$: activeCats = isRecurring ? data.recurringCategories : data.categories;
	// Recurring only: contract term (→ ServiceContract.Term) and how it is paid.
	let termMonths = 12;
	let payOption: 'full' | 'monthly' = 'full';

	function switchTab(t: 'services' | 'recurring') {
		if (t === tab) return;
		tab = t;
		selectedQty = {};
		activeCategory = 'All';
		query = '';
	}

	// Flatten categories → rows so the table can search/filter/sort uniformly.
	$: rows = activeCats.flatMap((cat) =>
		cat.products.map((p) => ({ ...p, categoryLabel: cat.category }))
	);

	let query = '';
	// pricebookEntryId → quantity, as a plain reactive object (not a Map —
	// Svelte tracks top-level assignment, and object property lookups in the
	// markup stay in sync without going through a helper function). A service
	// can be selected more than once (e.g. the same service purchased for
	// several store locations) — each unit of quantity becomes its own line
	// item and its own Case at checkout.
	let selectedQty: Record<string, number> = {};
	let busy = false;
	let activeCategory = 'All';
	const MAX_QTY = 20;

	$: categoryOptions = ['All', ...new Set(activeCats.map((c) => c.category))];

	$: filtered = rows.filter((r) => {
		if (activeCategory !== 'All' && r.categoryLabel !== activeCategory) return false;
		if (!query.trim()) return true;
		const q = query.toLowerCase();
		return (
			r.name.toLowerCase().includes(q) ||
			(r.description ?? '').toLowerCase().includes(q) ||
			(r.categoryLabel ?? '').toLowerCase().includes(q) ||
			(r.family ?? '').toLowerCase().includes(q)
		);
	});

	$: selectedEntries = rows
		.filter((r) => (selectedQty[r.pricebookEntryId] ?? 0) > 0)
		.map((r) => ({ row: r, qty: selectedQty[r.pricebookEntryId] ?? 0 }));
	$: totalUnits = selectedEntries.reduce((s, e) => s + e.qty, 0);
	// Recurring rows: unitPrice is the MONTHLY price per unit. Contract value = qty × price × term.
	$: total = selectedEntries.reduce((s, e) => s + e.row.unitPrice * e.qty * (isRecurring ? termMonths : 1), 0);
	$: currency = selectedEntries[0]?.row.currency ?? 'USD';

	// Deposit products are charged in parts: Salesforce creates a First Payment
	// (Full lines: price × qty, Deposit lines: deposit × qty) plus one payment
	// per line. Nothing is split when no selected line is a Deposit product.
	const lineDue = (e: { row: (typeof rows)[number]; qty: number }) =>
		(e.row.paymentType === 'Deposit' && e.row.depositAmount != null ? e.row.depositAmount : e.row.unitPrice) * e.qty;
	// Recurring: pay in full → (qty × price) × term today; pay by month → only the first month (qty × price).
	// Explicit args so Svelte re-runs the totals when term / payment option change.
	const lineDueRec = (e: { row: (typeof rows)[number]; qty: number }, pay: string, term: number) =>
		e.row.unitPrice * e.qty * (pay === 'full' ? term : 1);
	$: hasDeposit = isRecurring ? false : selectedEntries.some((e) => e.row.paymentType === 'Deposit');
	$: dueFirst = selectedEntries.reduce((s, e) => s + (isRecurring ? lineDueRec(e, payOption, termMonths) : lineDue(e)), 0);
	$: dueLater = total - dueFirst;

	$: visibleIds = filtered.map((r) => r.pricebookEntryId);
	$: allVisibleSelected =
		filtered.length > 0 && filtered.every((r) => (selectedQty[r.pricebookEntryId] ?? 0) > 0);
	$: someVisibleSelected =
		!allVisibleSelected && filtered.some((r) => (selectedQty[r.pricebookEntryId] ?? 0) > 0);

	function setQty(id: string, qty: number) {
		const clamped = Math.max(0, Math.min(MAX_QTY, qty));
		const next = { ...selectedQty };
		if (clamped === 0) delete next[id];
		else next[id] = clamped;
		selectedQty = next; // reassign the top-level object so Svelte re-renders
	}

	function toggle(id: string) {
		setQty(id, (selectedQty[id] ?? 0) > 0 ? 0 : 1);
	}

	function incQty(id: string) {
		setQty(id, (selectedQty[id] ?? 0) + 1);
	}

	function decQty(id: string) {
		setQty(id, (selectedQty[id] ?? 0) - 1);
	}

	function toggleAllVisible() {
		const next = { ...selectedQty };
		if (allVisibleSelected) {
			for (const id of visibleIds) delete next[id];
		} else {
			for (const id of visibleIds) if (!next[id]) next[id] = 1;
		}
		selectedQty = next;
	}

	function clearSelection() {
		selectedQty = {};
	}

	function continueToSummary() {
		if (totalUnits === 0 || busy) return;
		busy = true;
		const qs = new URLSearchParams();
		for (const [id, qty] of Object.entries(selectedQty)) {
			for (let i = 0; i < qty; i++) qs.append('id', id);
		}
		// Carry the store context into checkout so the resulting service
		// contract attaches to this store automatically.
		qs.append('store', data.store.id);
		if (isRecurring) {
			qs.append('kind', 'recurring');
			qs.append('term', String(termMonths));
			qs.append('pay', payOption);
		}
		goto(`/checkout/summary?${qs.toString()}`);
	}

	function formatPrice(amount: number, c: string) {
		try {
			return new Intl.NumberFormat('en-US', {
				style: 'currency', currency: c, maximumFractionDigits: 0
			}).format(amount);
		} catch {
			return `$${amount.toLocaleString()} ${c}`;
		}
	}
</script>

<svelte:head><title>Plan & Services — Appeals Doctor</title></svelte:head>

<Topbar
	title="Plan & Services"
	subtitle={`For ${data.store.name} — pick services to continue to checkout`}
>
	<a class="btn btn-outline btn-sm" href={`/stores/${data.store.id}`}>← Back to store</a>
</Topbar>

<div class="content-area">
	<!-- ── Plan banner / subscribe block ───────────────────────────── -->
	{#if data.activePlan}
		<div class="plan-banner">
			<div class="plan-banner-label">Your plan</div>
			<div class="plan-banner-main">
				<strong>{data.activePlan.name}</strong>
				{#if data.activePlan.price != null}— {formatPrice(data.activePlan.price, 'USD')} / 12 months{/if}
			</div>
			<div class="plan-banner-sub">Covers ongoing monitoring and AI assistants · {data.activePlan.cancelling ? `cancelled — ends ${data.activePlan.endDate}` : `renews ${data.activePlan.endDate}`}</div>
			<a class="btn btn-outline btn-sm" href={'/accounts/subscription'}>Compare plans</a>
		</div>
	{:else}
		<div class="subscribe-block">
			<div>
				<strong>No active subscription.</strong>
				Subscribe for ongoing monitoring and AI assistants for this store.
			</div>
			<a class="btn btn-primary btn-sm" href={'/accounts/subscription'}>Subscribe →</a>
		</div>
	{/if}

	{#if hasRecurring}
		<div class="tab-row" role="tablist">
			<button type="button" role="tab" class="tab" class:active={tab === 'services'} aria-selected={tab === 'services'} on:click={() => switchTab('services')}>Services</button>
			<button type="button" role="tab" class="tab" class:active={tab === 'recurring'} aria-selected={tab === 'recurring'} on:click={() => switchTab('recurring')}>Recurring products</button>
		</div>
	{/if}

	{#if isRecurring}
		<div class="rec-options">
			<label>Term
				<select class="form-control" bind:value={termMonths}>
					{#each data.recurringTerms as t}<option value={t}>{t} month{t === 1 ? '' : 's'}</option>{/each}
				</select>
			</label>
			<label>Payment option
				<select class="form-control" bind:value={payOption}>
					<option value="full">Pay in full</option>
					<option value="monthly">Pay by month</option>
				</select>
			</label>
			<p class="rec-hint">
				{#if payOption === 'full'}Charged today: quantity × monthly price × term.{:else}Only the first month (quantity × monthly price) is charged today; the remaining months are tracked as pending payments on the contract.{/if}
			</p>
		</div>
	{/if}

	<!-- ── Category pills ──────────────────────────────────────────── -->
	<div class="pill-row">
		{#each categoryOptions as cat}
			<button
				type="button"
				class="pill"
				class:active={activeCategory === cat}
				on:click={() => (activeCategory = cat)}
			>
				{cat}
			</button>
		{/each}
	</div>

	<!-- ── Toolbar ─────────────────────────────────────────────────── -->
	<div class="toolbar">
		<div class="search-wrap">
			<input
				type="search"
				class="form-control"
				placeholder="Search by name, description, or category…"
				bind:value={query}
			/>
		</div>
		<div class="toolbar-actions">
			<span class="count">
				{filtered.length} of {rows.length} services
				{#if totalUnits > 0}
					· <strong>{totalUnits}</strong> unit{totalUnits === 1 ? '' : 's'} selected
				{/if}
			</span>
			{#if totalUnits > 0}
				<button class="btn btn-outline btn-sm" on:click={clearSelection}>Clear</button>
			{/if}
		</div>
	</div>

	{#if rows.length === 0}
		<div class="empty">
			No services available right now. Make sure the SERVICE price book in Salesforce has active
			PricebookEntry rows whose Product2 records are also active.
		</div>
	{:else}
		<!-- ── Table ──────────────────────────────────────────────── -->
		<div class="table-wrap">
			<table class="data-table">
				<thead>
					<tr>
						<th class="col-check">
							<input
								type="checkbox"
								checked={allVisibleSelected}
								indeterminate={someVisibleSelected}
								on:change={toggleAllVisible}
								aria-label="Select all visible"
							/>
						</th>
						<th>Service</th>
						<th>Category</th>
						<th>Use this when…</th>
						<th class="col-qty">Qty</th>
						<th class="col-price">Price</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as r (r.pricebookEntryId)}
						{@const qty = selectedQty[r.pricebookEntryId] ?? 0}
						<tr
							class:row-selected={qty > 0}
							on:click={() => toggle(r.pricebookEntryId)}
						>
							<td class="col-check">
								<input
									type="checkbox"
									checked={qty > 0}
									on:click|stopPropagation={() => toggle(r.pricebookEntryId)}
									aria-label={`Select ${r.name}`}
								/>
							</td>
							<td>
								<div class="svc-name">{r.name}</div>
								{#if r.family}
									<div class="svc-family">{r.family}</div>
								{/if}
							</td>
							<td>{r.categoryLabel}</td>
							<td class="svc-desc">{r.description ?? '—'}</td>
							<td class="col-qty">
								{#if qty > 0}
									<div class="qty-stepper" on:click|stopPropagation role="presentation">
										<button
											type="button"
											class="qty-btn"
											on:click={() => decQty(r.pricebookEntryId)}
											aria-label={`Decrease quantity for ${r.name}`}
										>−</button>
										<span class="qty-val">{qty}</span>
										<button
											type="button"
											class="qty-btn"
											on:click={() => incQty(r.pricebookEntryId)}
											aria-label={`Increase quantity for ${r.name}`}
										>+</button>
									</div>
								{/if}
							</td>
							<td class="col-price">
								{#if isRecurring}
									{formatPrice(r.unitPrice * (qty || 1), r.currency)}<span class="per-mo"> / mo</span>
									<div class="dep-note">× {termMonths} mo = {formatPrice(r.unitPrice * (qty || 1) * termMonths, r.currency)}</div>
								{:else}
									{formatPrice(r.unitPrice * qty || r.unitPrice, r.currency)}
								{/if}
								{#if !isRecurring && r.paymentType === 'Deposit' && r.depositAmount != null}
									<div class="dep-note">
										<strong>{formatPrice(r.depositAmount * (qty || 1), r.currency)}</strong> deposit now
									</div>
									<div class="dep-split">Remaining {formatPrice((r.unitPrice - r.depositAmount) * (qty || 1), r.currency)} billed separately when the case is completed</div>
								{/if}
							</td>
						</tr>
					{:else}
						<tr>
							<td colspan="6" class="no-match">
								No services match "{query}". Try a different keyword.
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>

		{#if hasDeposit}
			<div class="split-banner" role="note">
				<strong>Payments will be split.</strong>
				{selectedEntries.length > 1
					? 'Some of the services you selected are paid in parts. '
					: 'This service is paid in parts. '}
				You pay <strong>{formatPrice(dueFirst, currency)}</strong> today, which covers
				{selectedEntries.some((e) => e.row.paymentType !== 'Deposit') ? 'the full price of standard services plus ' : ''}the deposit
				on the rest. The remaining <strong>{formatPrice(dueLater, currency)}</strong> is <strong>not charged today</strong> — each deposit service has its own payment, billed when that case is completed and shown on your Payments screen.
				{#if selectedEntries.length > 1}
					<ul>
						{#each selectedEntries as e}
							<li>
								{e.row.name}{e.qty > 1 ? ` × ${e.qty}` : ''} —
								{#if e.row.paymentType === 'Deposit'}
									{formatPrice(lineDue(e), e.row.currency)} deposit of {formatPrice(e.row.unitPrice * e.qty, e.row.currency)}
								{:else}
									{formatPrice(lineDue(e), e.row.currency)} in full
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		{/if}

		<!-- ── Footer bar with total + continue ───────────────────── -->
		<div class="footer-bar" class:disabled={totalUnits === 0}>
			<div class="footer-left">
				{#if totalUnits > 0}
					{totalUnits} unit{totalUnits === 1 ? '' : 's'} selected · subtotal
					<strong class="footer-total">{formatPrice(total, currency)}</strong>
					{#if hasDeposit || isRecurring}
						· {isRecurring ? 'due today' : 'first payment'} <strong class="footer-total">{formatPrice(dueFirst, currency)}</strong>
					{/if}
				{:else}
					Select one or more services to continue. The same service can be added more than once.
				{/if}
			</div>
			<button
				class="btn btn-primary"
				disabled={totalUnits === 0 || busy}
				on:click={continueToSummary}
			>
				{busy ? 'Loading…' : 'Continue to summary →'}
			</button>
		</div>
	{/if}
</div>

<style>
	.tab-row { display: flex; gap: 4px; border-bottom: 1px solid var(--grey-line); margin-bottom: 14px; }
	.tab { border: none; background: none; padding: 10px 16px; font-size: 13px; font-weight: 700; color: var(--grey-text); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; }
	.tab.active { color: var(--navy); border-bottom-color: var(--orange); }
	.rec-options { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 16px; background: white; border: 1px solid var(--grey-line); border-radius: var(--radius); padding: 14px 18px; margin-bottom: 14px; }
	.rec-options label { display: flex; flex-direction: column; gap: 4px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); }
	.rec-options select { min-width: 160px; text-transform: none; letter-spacing: 0; font-weight: 500; }
	.rec-hint { flex: 1; min-width: 220px; margin: 0; font-size: 12px; color: var(--grey-text); }
	.per-mo { font-size: 11px; font-weight: 500; color: var(--grey-text); }
	.dep-note { font-size: 12px; font-weight: 600; color: var(--navy); margin-top: 3px; }
	.dep-split { font-size: 11px; font-weight: 500; color: var(--grey-text); margin-top: 1px; max-width: 150px; margin-left: auto; }
	.split-banner {
		background: var(--orange-lt); border: 1px solid var(--orange); border-radius: var(--radius);
		padding: 12px 16px; margin-top: 14px; font-size: 13px; color: var(--navy); line-height: 1.5;
	}
	.split-banner ul { margin: 8px 0 0; padding-left: 18px; font-size: 12px; }
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px 110px; }

	.plan-banner {
		display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 16px 20px; margin-bottom: 16px;
	}
	.plan-banner-label {
		font-size: 10px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text);
	}
	.plan-banner-main { font-size: 14px; color: var(--navy); }
	.plan-banner-sub { font-size: 12px; color: var(--grey-text); flex: 1; }

	.subscribe-block {
		display: flex; align-items: center; justify-content: space-between; gap: 14px;
		background: var(--orange-lt); border: 1px solid var(--orange);
		border-radius: var(--radius); padding: 14px 20px; margin-bottom: 16px;
		font-size: 13px; color: var(--navy);
	}

	.pill-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
	.pill {
		border: 1px solid var(--grey-line); background: white; color: var(--grey-text);
		border-radius: 999px; padding: 6px 14px; font-size: 12px; font-weight: 600;
		cursor: pointer; transition: all .12s;
	}
	.pill:hover { border-color: var(--orange); color: var(--navy); }
	.pill.active { background: var(--navy); border-color: var(--navy); color: white; }

	.toolbar {
		display: flex; align-items: center; gap: 16px;
		margin-bottom: 16px;
	}
	.search-wrap { flex: 1; max-width: 460px; }
	.toolbar-actions { display: flex; align-items: center; gap: 12px; margin-left: auto; }
	.count { font-size: 13px; color: var(--grey-text); }

	.table-wrap {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); overflow: hidden;
	}
	.data-table { width: 100%; border-collapse: collapse; font-size: 14px; }
	.data-table thead th {
		text-align: left; padding: 12px 14px; font-size: 11px;
		text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text);
		font-weight: 700; background: #fafafa; border-bottom: 1px solid var(--grey-line);
	}
	.data-table tbody tr {
		border-bottom: 1px solid var(--grey-line); cursor: pointer;
		transition: background-color .12s;
	}
	.data-table tbody tr:hover { background: #fafafa; }
	.data-table tbody tr.row-selected { background: #fff5ec; }
	.data-table tbody tr.row-selected:hover { background: #fef0e1; }
	.data-table td { padding: 12px 14px; vertical-align: top; }

	.col-check { width: 38px; }
	.col-qty { width: 108px; }
	.col-price { width: 130px; text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }

	.qty-stepper {
		display: inline-flex; align-items: center; gap: 8px;
		border: 1px solid var(--grey-line); border-radius: 8px;
		padding: 3px 4px; background: white;
	}
	.qty-btn {
		width: 20px; height: 20px; border-radius: 5px; border: none;
		background: #f3f4f6; color: var(--navy); font-size: 13px; font-weight: 700;
		line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center;
	}
	.qty-btn:hover { background: var(--orange); color: white; }
	.qty-val { min-width: 16px; text-align: center; font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; }

	.svc-name { font-weight: 600; color: var(--navy); }
	.svc-family { font-size: 11px; color: var(--grey-text); margin-top: 2px; }
	.svc-desc { color: var(--grey-text); max-width: 460px; }

	.no-match { text-align: center; padding: 28px; color: var(--grey-text); }

	.footer-bar {
		position: fixed; left: 230px; right: 0; bottom: 0;
		background: white; border-top: 1px solid var(--grey-line);
		padding: 14px 26px; display: flex; align-items: center; justify-content: space-between;
		box-shadow: 0 -2px 8px rgba(0,0,0,.04); z-index: 10;
	}
	.footer-bar.disabled .footer-left { color: var(--grey-text); }
	.footer-total { font-size: 18px; color: var(--navy); margin-left: 4px; }

	.empty {
		background: white; border: 1px dashed var(--grey-line);
		border-radius: var(--radius); padding: 26px;
		font-size: 14px; color: var(--grey-text); line-height: 1.5;
	}
</style>
