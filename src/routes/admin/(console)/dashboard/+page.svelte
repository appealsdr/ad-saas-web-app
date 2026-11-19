<script lang="ts">
	import { onMount } from 'svelte';
	import { useAdminTime } from '$lib/admin/tz';
	import type { UsageResult } from '$lib/server/admin/usage';
	import type { PageData } from './$types';
	export let data: PageData;

	const { tz, fmt } = useAdminTime();
	const PERIODS = [['today', 'Today'], ['week', 'This week'], ['month', 'This month']] as const;
	let res: UsageResult = data.initial;
	let period: 'today' | 'week' | 'month' = data.initial.period;
	let includeStaff = false;
	let loading = false;
	let error = '';

	async function load() {
		loading = true; error = '';
		try {
			const r = await fetch(`/admin/dashboard/data?period=${period}&tz=${encodeURIComponent($tz)}&staff=${includeStaff ? 1 : 0}`);
			if (!r.ok) throw new Error(String(r.status));
			res = await r.json();
		} catch { error = 'Could not load the dashboard. Try again.'; }
		loading = false;
	}
	// No saved zone: the server used UTC for the first paint — re-request in the browser's zone.
	onMount(() => { if (!data.hasSavedTz && $tz !== 'UTC') load(); });

	const dur = (ms: number) => {
		const s = Math.round(ms / 1000);
		if (s < 60) return `${s}s`;
		const m = Math.floor(s / 60);
		return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
	};
	$: maxUsers = Math.max(1, ...res.trend.map((t) => t.users));
	$: label = (l: string) => (res.trendUnit === 'hour' ? `${Number(l)}:00` : l.slice(5));
</script>

<svelte:head><title>Dashboard — Admin</title></svelte:head>
<div class="head">
	<div>
		<h1 class="adm-h1">Usage dashboard</h1>
		<p class="adm-sub">Customer app usage. Periods follow your time zone ({$tz}). Time on page counts only visible time.</p>
	</div>
	<div class="ctl">
		<div class="seg" role="tablist" aria-label="Period">
			{#each PERIODS as [k, l]}<button type="button" role="tab" aria-selected={period === k} class:active={period === k} on:click={() => { period = k; load(); }}>{l}</button>{/each}
		</div>
		<label class="chk"><input type="checkbox" bind:checked={includeStaff} on:change={load} /> Include admin sessions</label>
	</div>
</div>
{#if error}<div class="adm-alert error" role="alert">{error}</div>{/if}
<p class="adm-muted" aria-live="polite">{loading ? 'Loading…' : `${$fmt(res.range.start)} → ${$fmt(res.range.end)}`}</p>

<div class="kpis" class:dim={loading}>
	<div class="kpi"><span>Active users</span><strong>{res.totals.activeUsers}</strong><em>unique users who logged in</em></div>
	<div class="kpi"><span>Logins</span><strong>{res.totals.logins}</strong><em>{res.totals.sessions} sessions</em></div>
	<div class="kpi"><span>Page views</span><strong>{res.totals.pageViews}</strong><em>across all pages</em></div>
</div>

<div class="adm-card" class:dim={loading}>
	<h2>{res.trendUnit === 'hour' ? 'Active users by hour' : 'Daily active users'}</h2>
	{#if res.trend.every((t) => t.users === 0)}<div class="adm-empty">No activity in this period.</div>{:else}
		<svg viewBox="0 0 {res.trend.length * 22 + 20} 150" class="chart" role="img" aria-label="Active users per {res.trendUnit}">
			{#each res.trend as t, i}
				{@const h = (t.users / maxUsers) * 100}
				<g><title>{label(t.label)}: {t.users} user{t.users === 1 ? '' : 's'}</title>
					<rect x={10 + i * 22} y={110 - h} width="16" height={h} rx="2" class="bar" />
					{#if res.trend.length <= 31 && (i % (res.trend.length > 14 ? 3 : 1) === 0)}<text x={18 + i * 22} y="128" text-anchor="middle" class="tick">{label(t.label)}</text>{/if}
				</g>
			{/each}
		</svg>
	{/if}
</div>

<div class="two" class:dim={loading}>
	<div class="adm-card">
		<h2>Top pages by time spent</h2>
		{#if res.topTime.length === 0}<div class="adm-empty">No time-on-page data yet for this period.</div>{:else}
			<table class="adm-table"><thead><tr><th scope="col">Page</th><th scope="col">Total</th><th scope="col">Avg / visit</th><th scope="col">Visits</th></tr></thead>
				<tbody>{#each res.topTime as r}<tr><td class="adm-mono">{r.path}</td><td>{dur(r.totalMs)}</td><td>{dur(r.avgMs)}</td><td>{r.visits}</td></tr>{/each}</tbody></table>
		{/if}
	</div>
	<div class="adm-card">
		<h2>Most visited pages</h2>
		{#if res.topViews.length === 0}<div class="adm-empty">No page views in this period.</div>{:else}
			<table class="adm-table"><thead><tr><th scope="col">Page</th><th scope="col">Views</th><th scope="col">Users</th></tr></thead>
				<tbody>{#each res.topViews as r}<tr><td class="adm-mono">{r.path}</td><td>{r.views}</td><td>{r.users}</td></tr>{/each}</tbody></table>
		{/if}
	</div>
	<div class="adm-card">
		<h2>Most active accounts</h2>
		{#if res.topAccounts.length === 0}<div class="adm-empty">No activity in this period.</div>{:else}
			<table class="adm-table"><thead><tr><th scope="col">Account</th><th scope="col">Events</th><th scope="col">Users</th></tr></thead>
				<tbody>{#each res.topAccounts as r}<tr><td><a href="/admin/accounts/{r.id}">{r.name}</a></td><td>{r.events}</td><td>{r.users}</td></tr>{/each}</tbody></table>
		{/if}
	</div>
	<div class="adm-card">
		<h2>Most active users</h2>
		{#if res.topUsers.length === 0}<div class="adm-empty">No activity in this period.</div>{:else}
			<table class="adm-table"><thead><tr><th scope="col">User</th><th scope="col">Account</th><th scope="col">Events</th></tr></thead>
				<tbody>{#each res.topUsers as r}<tr><td>{r.name ?? ''}<br /><span class="adm-muted">{r.email}</span></td><td>{r.account ?? '—'}</td><td>{r.events}</td></tr>{/each}</tbody></table>
		{/if}
	</div>
</div>

<style>
	.head { display: flex; justify-content: space-between; gap: 16px; flex-wrap: wrap; align-items: flex-start; }
	.ctl { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
	.seg { display: flex; border: 1px solid var(--grey-line); border-radius: 99px; overflow: hidden; background: #fff; }
	.seg button { background: none; border: 0; padding: 7px 16px; font: inherit; font-size: 13px; font-weight: 700; color: var(--navy); cursor: pointer; }
	.seg button.active { background: var(--navy); color: #fff; }
	.chk { font-size: 12px; color: var(--grey-text); display: flex; gap: 6px; align-items: center; }
	.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 14px; }
	.kpi { background: #fff; border: 1px solid var(--grey-line); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 2px; }
	.kpi span { font-size: 12px; font-weight: 700; color: var(--grey-text); text-transform: uppercase; letter-spacing: .04em; }
	.kpi strong { font-size: 30px; color: var(--navy); font-variant-numeric: tabular-nums; }
	.kpi em { font-style: normal; font-size: 12px; color: var(--grey-text); }
	.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(380px, 1fr)); gap: 14px; }
	.dim { opacity: .55; transition: opacity .15s; }
	.chart { width: 100%; height: auto; max-height: 220px; }
	.bar { fill: var(--orange, #F5A100); }
	.tick { font-size: 9px; fill: var(--grey-text); }
	h2 { font-size: 15px; margin: 0 0 10px; }
</style>
