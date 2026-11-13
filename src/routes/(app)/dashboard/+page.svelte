<script lang="ts">
	import CaseStepsCell from '$components/cases/CaseStepsCell.svelte';
	import Topbar from '$components/layout/Topbar.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	// ── Formatters ──
	function fmtDateShort(iso: string | null | undefined) {
		if (!iso) return '—';
		try {
			return new Date(iso).toLocaleDateString('en-US', {
				month: 'short', day: 'numeric'
			});
		} catch {
			return iso;
		}
	}
	function fmtRelative(iso: string | null | undefined) {
		if (!iso) return '—';
		const t = new Date(iso).getTime();
		if (!Number.isFinite(t)) return '—';
		const diff = Date.now() - t;
		const m = Math.floor(diff / 60000);
		if (m < 1) return 'just now';
		if (m < 60) return `${m}m ago`;
		const h = Math.floor(m / 60);
		if (h < 24) return `${h}h ago`;
		const d = Math.floor(h / 24);
		if (d < 7) return `${d}d ago`;
		return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
	}

	const STATUS_BADGE: Record<string, string> = {
		new: 'badge-orange', open: 'badge-orange',
		working: 'badge-blue', 'in progress': 'badge-blue',
		'waiting on client': 'badge-red', waiting: 'badge-red', pending: 'badge-red',
		closed: 'badge-green', resolved: 'badge-green'
	};
	function badgeClass(status: string): string {
		return STATUS_BADGE[status.toLowerCase()] ?? 'badge-grey';
	}
	function isWaitingOnClient(status: string): boolean {
		const s = status.toLowerCase();
		return s.includes('waiting') || s.includes('pending') || s.includes('awaiting');
	}

	function truncate(s: string | null, n: number): string {
		if (!s) return '';
		return s.length > n ? s.slice(0, n - 1) + '…' : s;
	}
</script>

<svelte:head><title>Dashboard — Appeals Doctor</title></svelte:head>

<Topbar
	title={data.account ? `Welcome, ${data.account.displayName ?? data.account.email ?? ''}` : 'Dashboard'}
	subtitle={data.account?.name ? `${data.account.name} · overview` : 'Overview of your account activity'}
/>

<div class="content-area">
	{#if data.errors.cases}
		<div class="alert alert-error" style="margin-bottom:16px">
			Could not load cases from Salesforce: {data.errors.cases}
		</div>
	{/if}

	<!-- ─── Stats row ──────────────────────────────────────────── -->
	<div class="stats-grid">
		<a class="stat-card" href="/issues">
			<div class="stat-label">Open Cases</div>
			<div class="stat-value">{data.stats.openCases}</div>
			<div class="stat-sub">
				{data.stats.inProgressCases} in progress · {data.stats.waitingCases} waiting
			</div>
		</a>
		<a class="stat-card" href="/stores">
			<div class="stat-label">Active Stores</div>
			<div class="stat-value">{data.stats.totalStores}</div>
			<div class="stat-sub">
				{#if data.stats.totalStores === 0}
					Add your first store →
				{:else}
					{data.stats.connectedStores} connected via SP-API
				{/if}
			</div>
		</a>
		<a class="stat-card" href="/issues?filter=waiting">
			<div class="stat-label">Action Required</div>
			<div class="stat-value" class:warn={data.stats.pendingFiles > 0}>{data.stats.pendingFiles}</div>
			<div class="stat-sub">
				{#if data.stats.pendingFiles === 0}
					Nothing waiting on you
				{:else}
					Documents or info awaiting you
				{/if}
			</div>
		</a>
		<div class="stat-card no-link">
			<div class="stat-label">Resolved This Month</div>
			<div class="stat-value">{data.stats.resolvedThisMonth}</div>
			<div class="stat-sub">
				of {data.stats.totalCases} total cases
			</div>
		</div>
	</div>

	<!-- ─── Outstanding payments: contracts awaiting payment ────── -->
	{#if data.outstanding.length > 0}
		<div class="card" style="margin-bottom:20px">
			<div class="card-title">
				Outstanding Payments
				<a href="/payments" class="hdr-link" style="margin-left:auto">All payments →</a>
			</div>
			{#each data.outstanding as c (c.id)}
				<div class="out-contract">
					<svelte:element this={c.payHref ? 'a' : 'div'} class="out-head" href={c.payHref ?? undefined}>
						<div>
							<div class="out-name">{c.name}</div>
							<div class="out-sub">
								{c.number ?? ''}{c.startDate ? ` · ${c.startDate}${c.endDate ? ' → ' + c.endDate : ''}` : ''}
							</div>
						</div>
						<div class="out-total">
							${c.totalDue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
							{#if c.payHref}<span class="out-pay">Pay →</span>{/if}
						</div>
					</svelte:element>
					{#each c.payments as p (p.id)}
						<div class="out-row">
							<span>{p.description ?? p.name}{p.dueDate ? ` · due ${p.dueDate}` : ''}</span>
							<span>${p.amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
							{#if p.payable}
								<a class="btn btn-primary btn-sm" href={`/payments/pay/${p.id}`}>Pay</a>
							{:else}
								<span class="badge badge-grey">{p.status === 'Failed' ? 'Failed' : 'Not ready yet'}</span>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
	{/if}

	<!-- ─── Action required: pending files + onboarding info, per store / case ────── -->
	{#if data.actions.length > 0}
		<div class="req-action-card">
			<div class="req-action-hdr">
				<div class="hdr-left">
					<img class="hdr-icon" src="/icons/warning.png" alt="" aria-hidden="true" />
					<h3>Action Required</h3>
					<span class="count-badge">{data.actionSummary.todos}</span>
				</div>
				<a href="/issues" class="hdr-link">View all cases →</a>
			</div>
			{#each data.actions as a (a.key)}
				<a class="req-action-item warning" href={a.href}>
					<div class="req-item-icon warning"><img class="file-icn" src="/icons/file.png" alt="" aria-hidden="true" /></div>
					<div class="req-item-body">
						<div class="req-item-title">{a.title}</div>
						{#if a.subtitle}<div class="req-item-sub">{a.subtitle}</div>{/if}
						<ul class="req-todos">
							{#each a.todos as t}
								<li>{t.text}</li>
							{/each}
						</ul>
					</div>
					<div class="req-item-right">
						<span class="badge {a.scope === 'store' ? 'badge-blue' : 'badge-grey'}">
							{a.scope === 'store' ? 'Store' : 'Case'}
						</span>
						<span class="req-item-time">{a.todos.some((t) => t.kind === 'onboarding') ? 'Provide info →' : 'Upload →'}</span>
					</div>
				</a>
			{/each}
			{#if data.actionSummary.rows > data.actions.length}
				<div class="req-more">
					+ {data.actionSummary.rows - data.actions.length} more with actions pending — open each store or case
				</div>
			{/if}
		</div>
	{:else if data.errors.requiredFiles}
		<div class="alert alert-warn" style="margin-bottom:20px">
			Could not check required files: {data.errors.requiredFiles}
		</div>
	{:else if data.requiredSummary.total > 0}
		<div class="alert alert-ok" style="margin-bottom:20px">
			All {data.requiredSummary.total} required files uploaded ✓
		</div>
	{/if}

	<!-- ─── Two-column: Recent Cases + Recent Activity ────────── -->
	<div class="grid-2">
		<!-- Recent Cases -->
		<div class="card">
			<div class="card-title">
				Recent Cases
				<a href="/issues" class="view-all">View all →</a>
			</div>
			{#if data.recentCases.length === 0}
				{#if data.stats.totalStores === 0}
					<p class="empty-line">
						No stores yet. <a href="/stores" class="link">Add a store</a> to start tracking cases.
					</p>
				{:else}
					<p class="empty-line">No cases yet for any of your stores.</p>
				{/if}
			{:else}
				<table class="data-table">
					<thead>
						<tr>
							<th>Case</th>
							<th>Store</th>
							<th>Status</th>
							<th>Updated</th>
						</tr>
					</thead>
					<tbody>
						{#each data.recentCases as c (c.Id)}
							<tr
								class:clickable={!!c.localStoreId}
								class:row-waiting={isWaitingOnClient(c.Status)}
								on:click={() => {
									if (c.localStoreId) location.assign(`/stores/${c.localStoreId}/issues/${c.Id}`);
								}}
							>
								<td>
									<div class="case-num">{c.CaseNumber}</div>
									<div class="case-sub">{c.recordTypeName ?? c.Subject ?? '—'}</div>
									<CaseStepsCell steps={c.steps} closed={/closed|resolved/i.test(c.Status)} />
								</td>
								<td>{c.storeName ?? '—'}</td>
								<td><span class={`badge ${badgeClass(c.Status)}`}>{c.Status}</span></td>
								<td class="muted-small">{fmtRelative(c.LastModifiedDate)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>

		<!-- Recent Activity (comments) -->
		<div class="card">
			<div class="card-title">
				Latest Comments
				{#if data.recentComments.length > 0}
					<span style="font-size:11px;font-weight:500;color:var(--grey-text)">
						{data.recentComments.length} recent
					</span>
				{/if}
			</div>
			{#if data.errors.comments}
				<div class="alert alert-error" style="margin-bottom:10px">
					Could not load comments: {data.errors.comments}
				</div>
			{:else if data.recentComments.length === 0}
				<p class="empty-line">No comments yet across your cases.</p>
			{:else}
				{#each data.recentComments as m (m.Id)}
					<a
						class="activity-item"
						href={m.localStoreId ? `/stores/${m.localStoreId}/issues/${m.caseId}` : '/issues'}
					>
						<div class="a-icon a-comment"><img class="a-icn" src="/icons/case_comment.png" alt="" aria-hidden="true" /></div>
						<div class="a-body">
							<div class="a-title">
								{m.displayName ?? m.senderContactName ?? m.createdByName ?? 'Sender'}
								on Case {m.caseNumber || m.caseId.slice(0, 8)}
							</div>
							<div class="a-sub a-richtext">{@html m.body}</div>
							{#if m.storeName}
								<div class="a-meta">{m.storeName}{m.senderType ? ` · ${m.senderType}` : ''}</div>
							{/if}
						</div>
						<div class="a-time">{fmtRelative(m.createdAt)}</div>
					</a>
				{/each}
			{/if}
		</div>
	</div>
</div>

<style>
	.out-contract { border: 1px solid var(--grey-line); border-radius: 10px; margin-bottom: 10px; overflow: hidden; }
	.out-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 14px; background: #FFF7ED; color: inherit; text-decoration: none; }
	a.out-head:hover { background: #FFEDD5; }
	.out-name { font-weight: 700; color: var(--navy); }
	.out-sub { font-size: 12px; color: var(--grey-text); }
	.out-total { font-weight: 800; display: flex; gap: 10px; align-items: center; }
	.out-pay { color: var(--orange); font-size: 13px; }
	.out-row { display: flex; align-items: center; gap: 12px; padding: 8px 14px; font-size: 13px; border-top: 1px solid var(--grey-line); }
	.out-row span:first-child { flex: 1; }

	:global(:root) { --orange-dk: #c47a00; }

	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }

	/* ── Stats row ──────────────────────────────────────────── */
	.stats-grid {
		display: grid; grid-template-columns: repeat(4, 1fr);
		gap: 14px; margin-bottom: 20px;
	}
	.stat-card {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 18px 20px;
		text-decoration: none; color: inherit; display: block;
		transition: all .2s;
	}
	.stat-card:not(.no-link):hover {
		border-color: var(--orange); box-shadow: 0 4px 16px rgba(0,0,0,.06);
		transform: translateY(-1px);
	}
	.stat-card.no-link { cursor: default; }
	.stat-label {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .06em; color: var(--grey-text); margin-bottom: 8px;
	}
	.stat-value { font-size: 30px; font-weight: 800; color: var(--navy); line-height: 1.1; }
	.stat-value.warn { color: var(--orange); }
	.stat-sub { font-size: 12px; color: var(--grey-text); margin-top: 4px; }

	/* ── Required Actions card ─────────────────────────────── */
	.req-action-card {
		background: white; border-radius: var(--radius);
		border: 1px solid var(--grey-line); overflow: hidden;
		margin-bottom: 20px;
	}
	.req-action-hdr {
		padding: 14px 20px; display: flex; align-items: center;
		justify-content: space-between; border-bottom: 1px solid var(--grey-line);
		background: #fee2e2;
	}
	.hdr-left { display: flex; align-items: center; gap: 10px; }
	.hdr-icon { width: 20px; height: 20px; object-fit: contain; }
	.file-icn { width: 18px; height: 18px; object-fit: contain; display: block; }
	.req-action-hdr h3 { font-size: 14px; font-weight: 700; color: #b91c1c; margin: 0; }
	.count-badge {
		background: #b91c1c; color: white; font-size: 11px; font-weight: 700;
		padding: 2px 8px; border-radius: 10px;
	}
	.hdr-link {
		font-size: 12px; color: #b91c1c; font-weight: 600; text-decoration: none;
	}
	.hdr-link:hover { text-decoration: underline; }

	.req-action-item {
		display: flex; align-items: flex-start; gap: 14px;
		padding: 14px 20px; border-bottom: 1px solid var(--grey-line);
		border-left: 3px solid #f59e0b;
		text-decoration: none; color: inherit;
		transition: background .15s;
	}
	.req-action-item:last-child { border-bottom: none; }
	.req-action-item:hover { background: #fafbfc; }
	.req-item-icon {
		width: 36px; height: 36px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		font-size: 16px; flex-shrink: 0; background: var(--navy-dark);
	}
	.req-item-body { flex: 1; min-width: 0; }
	.req-item-title { font-size: 13px; font-weight: 700; color: var(--navy); margin-bottom: 3px; }
	.req-item-sub { font-size: 12px; color: var(--grey-text); line-height: 1.4; }
	.req-item-right { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; flex-shrink: 0; }
	.req-item-time { font-size: 11px; color: var(--grey-text); }
	.req-todos { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; font-weight: 500; color: #b45309; }
	.req-todos li::before { content: '• '; }
	.req-more { padding: 10px 20px; font-size: 12px; color: var(--grey-text); background: #fafbfc; }

	/* ── Card / grid ──────────────────────────────────────── */
	.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
	.card {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 18px 20px;
	}
	.card-title {
		display: flex; align-items: center; justify-content: space-between;
		font-size: 14px; font-weight: 700; color: var(--navy);
		margin-bottom: 14px; padding-bottom: 10px;
		border-bottom: 1px solid var(--grey-line);
	}
	.view-all { font-size: 12px; color: var(--orange); font-weight: 600; text-decoration: none; }
	.view-all:hover { text-decoration: underline; }

	.link { color: var(--orange); font-weight: 600; }
	.empty-line { color: var(--grey-text); font-size: 13px; margin: 8px 0 0; }

	/* ── Data table ──────────────────────────────────────── */
	.data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
	.data-table thead th {
		text-align: left; padding: 8px 10px; font-size: 11px;
		font-weight: 700; text-transform: uppercase; letter-spacing: .05em;
		color: var(--grey-text); border-bottom: 1px solid var(--grey-line);
	}
	.data-table tbody tr { border-bottom: 1px solid var(--grey-line); transition: background .12s; }
	.data-table tbody tr:last-child { border-bottom: none; }
	.data-table tbody tr.clickable { cursor: pointer; }
	.data-table tbody tr.clickable:hover { background: #fafafa; }
	.data-table tbody tr.row-waiting { border-left: 3px solid #b91c1c; background: #fef2f2; }
	.data-table tbody tr.row-waiting:hover { background: #fee2e2; }
	.data-table td { padding: 11px 10px; vertical-align: middle; }
	.case-num {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		font-weight: 600; color: var(--navy);
	}
	.case-sub { font-size: 11px; color: var(--grey-text); margin-top: 2px; }
	.muted-small { color: var(--grey-text); font-size: 11px; }

	/* ── Badges (mockup) ──────────────────────────────────── */
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

	/* ── Activity (Latest Comments) ──────────────────────── */
	.activity-item {
		display: flex; align-items: flex-start; gap: 12px;
		padding: 11px 0; border-bottom: 1px solid var(--grey-line);
		text-decoration: none; color: inherit;
		transition: background .12s;
	}
	.activity-item:last-child { border-bottom: none; }
	.activity-item:hover { background: #fafafa; }
	.a-icon {
		width: 32px; height: 32px; border-radius: 50%;
		display: flex; align-items: center; justify-content: center;
		font-size: 14px; flex-shrink: 0;
	}
	.a-icon.a-comment { background: var(--navy-dark); }
	.a-icn { width: 18px; height: 18px; object-fit: contain; display: block; }
	.a-body { flex: 1; min-width: 0; }
	.a-title { font-size: 13px; font-weight: 600; color: var(--navy); }
	.a-sub   { font-size: 12px; color: var(--grey-text); margin-top: 3px; line-height: 1.45; }
	.a-richtext {
		display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2;
		-webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
	}
	.a-richtext :global(p) { margin: 0; }
	.a-richtext :global(ul), .a-richtext :global(ol) { margin: 2px 0; padding-left: 18px; }
	.a-richtext :global(a) { color: var(--orange-dk); text-decoration: underline; }
	.a-meta  { font-size: 11px; color: var(--grey-text); margin-top: 3px; }
	.a-time  { font-size: 11px; color: var(--grey-text); white-space: nowrap; flex-shrink: 0; }

	/* ── Alerts ──────────────────────────────────────────── */
	.alert { border-radius: 9px; padding: 12px 16px; font-size: 13px; }
	.alert-warn  { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; }
	.alert-error { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; }
	.alert-ok    { background: #d1fae5; border: 1px solid #6ee7b7; color: #047857; }
</style>
