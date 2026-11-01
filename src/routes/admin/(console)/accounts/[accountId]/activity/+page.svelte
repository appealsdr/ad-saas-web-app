<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type { PageData } from './$types';
	export let data: PageData;

	$: base = `/admin/accounts/${$page.params.accountId}/activity`;
	function go(patch: Record<string, string>) {
		const p = new URLSearchParams($page.url.searchParams);
		for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
		goto(`${base}?${p}`, { keepFocus: true, noScroll: true });
	}
	const ago = (d: Date | string | null) => {
		if (!d) return 'never';
		const s = Math.max(0, (Date.now() - new Date(d).getTime()) / 1000);
		return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 86400 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86400)} d ago`;
	};
	const ts = (d: Date | string) => new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
	const dur = (ms: number | null) => (ms == null ? '—' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)} min`);
	const TYPE_CHIP: Record<string, [string, string]> = {
		page_view: ['#DBEAFE', '#1d4ed8'], click: ['#F1F5F9', '#475569'], action: ['#FEF3C7', '#92400e'], login: ['#DCFCE7', '#15803d'], logout: ['#F1F5F9', '#475569']
	};
	const describe = (e: PageData['recent'][number]) => {
		const d = (e.event_data ?? {}) as Record<string, string | number | undefined>;
		switch (e.event_type) {
			case 'page_view': return `Opened ${d.path}${d.from ? ` (from ${d.from})` : ''}${d.title ? ` — ${d.title}` : ''}`;
			case 'click': return `Clicked “${d.label ?? d.href ?? '?'}” on ${d.path}${d.href && d.label ? ` → ${d.href}` : ''}`;
			case 'action': return `${d.method} ${d.path}${d.action ? ` ?/${d.action}` : ''} → ${d.status}`;
			case 'login': return 'Signed in';
			case 'logout': return 'Signed out';
			default: return JSON.stringify(d);
		}
	};
	$: maxDay = Math.max(1, ...data.daily.map((d) => d.events));
	$: t = data.totals;
</script>

<svelte:head><title>App activity — Admin</title></svelte:head>

<div class="adm-card">
	<div class="bar">
		<div>
			<h2 style="margin:0">App activity</h2>
			<div class="adm-muted">What users in this account opened, clicked and changed inside the customer app. Typed text and form values are never recorded.</div>
		</div>
		<span style="flex:1"></span>
		<label class="f">Period
			<select class="adm-input" value={String(data.filters.days)} on:change={(e) => go({ days: e.currentTarget.value })}>
				{#each data.ranges as r}<option value={String(r)}>{r === 1 ? 'Last 24 hours' : `Last ${r} days`}</option>{/each}
			</select>
		</label>
		<label class="f">User
			<select class="adm-input" value={data.filters.user} on:change={(e) => go({ user: e.currentTarget.value })}>
				<option value="">All users</option>
				{#each data.perUser as u}<option value={u.id}>{u.display_name ?? u.email}</option>{/each}
			</select>
		</label>
	</div>

	<div class="kpis">
		<div class="kpi"><span class="kl">Active users</span><span class="kv">{t.users}</span><span class="ks">of {data.perUser.length}</span></div>
		<div class="kpi"><span class="kl">Sessions</span><span class="kv">{t.sessions}</span><span class="ks">{t.logins} sign-ins</span></div>
		<div class="kpi"><span class="kl">Page views</span><span class="kv">{t.page_views}</span></div>
		<div class="kpi"><span class="kl">Clicks</span><span class="kv">{t.clicks}</span></div>
		<div class="kpi"><span class="kl">Changes made</span><span class="kv">{t.actions}</span><span class="ks">form submits &amp; API writes</span></div>
		<div class="kpi"><span class="kl">Last activity</span><span class="kv sm">{ago(t.last_at)}</span><span class="ks">{t.last_at ? ts(t.last_at) : ''}</span></div>
	</div>

	{#if t.events === 0}
		<div class="adm-empty">No activity recorded in this period. Tracking starts when users open the app after this release.</div>
	{/if}
</div>

{#if data.daily.length}
	<div class="adm-card">
		<h2>Daily activity</h2>
		<div class="chart" role="img" aria-label="Events per day">
			{#each data.daily as d}
				<div class="col" title="{d.day}: {d.events} events, {d.users} user{d.users === 1 ? '' : 's'}">
					<div class="barfill" style="height:{Math.max(4, (d.events / maxDay) * 100)}%"></div>
					<span class="lbl">{d.day.slice(5)}</span>
				</div>
			{/each}
		</div>
	</div>
{/if}

<div class="adm-card">
	<h2>By user</h2>
	<div class="adm-table-wrap"><table class="adm-table">
		<caption class="adm-sr">Activity per user</caption>
		<thead><tr><th scope="col">User</th><th scope="col">Role</th><th scope="col">Last seen</th><th scope="col">Sessions</th><th scope="col">Page views</th><th scope="col">Clicks</th><th scope="col">Changes</th><th scope="col">Most visited page</th></tr></thead>
		<tbody>
			{#each data.perUser as u (u.id)}
				<tr>
					<td><button class="link" type="button" title="Filter to this user" on:click={() => go({ user: u.id })}>{u.display_name ?? u.email}</button><br /><span class="adm-muted">{u.email}</span></td>
					<td>{u.role}</td>
					<td>{ago(u.last_at)}{#if u.last_at}<br /><span class="adm-muted">{ts(u.last_at)}</span>{/if}</td>
					<td>{u.sessions}</td><td>{u.page_views}</td><td>{u.clicks}</td><td>{u.actions}</td>
					<td class="adm-mono">{u.top_page ?? '—'}</td>
				</tr>
			{/each}
		</tbody>
	</table></div>
</div>

<div class="two">
	<div class="adm-card">
		<h2>Top pages</h2>
		{#if data.topPages.length === 0}<div class="adm-empty">No page views.</div>{:else}
			<table class="adm-table"><thead><tr><th scope="col">Page</th><th scope="col">Views</th><th scope="col">Users</th><th scope="col">Avg. time before next page</th></tr></thead>
				<tbody>{#each data.topPages as p}<tr><td class="adm-mono">{p.path}</td><td>{p.views}</td><td>{p.users}</td><td>{dur(p.avg_ms)}</td></tr>{/each}</tbody></table>
		{/if}
	</div>
	<div class="adm-card">
		<h2>Most clicked</h2>
		{#if data.topClicks.length === 0}<div class="adm-empty">No clicks.</div>{:else}
			<table class="adm-table"><thead><tr><th scope="col">Button / link</th><th scope="col">On page</th><th scope="col">Clicks</th></tr></thead>
				<tbody>{#each data.topClicks as c}<tr><td>{c.label}</td><td class="adm-mono">{c.path}</td><td>{c.n}</td></tr>{/each}</tbody></table>
		{/if}
	</div>
</div>

<div class="adm-card">
	<div class="bar">
		<h2 style="margin:0">Activity timeline</h2>
		<span style="flex:1"></span>
		<div class="pills">
			<button type="button" class="pill" class:active={!data.filters.type} on:click={() => go({ type: '' })}>All</button>
			{#each data.types as ty}<button type="button" class="pill" class:active={data.filters.type === ty} on:click={() => go({ type: ty })}>{ty.replace('_', ' ')}</button>{/each}
		</div>
	</div>
	{#if data.recent.length === 0}<div class="adm-empty">Nothing to show.</div>{:else}
		<div class="adm-table-wrap"><table class="adm-table">
			<caption class="adm-sr">Recent activity</caption>
			<thead><tr><th scope="col">When</th><th scope="col">User</th><th scope="col">Event</th><th scope="col">Detail</th></tr></thead>
			<tbody>
				{#each data.recent as e (e.id)}
					{@const c = TYPE_CHIP[e.event_type] ?? TYPE_CHIP.click}
					<tr>
						<td class="adm-mono" style="white-space:nowrap">{ts(e.created_at)}</td>
						<td>{e.display_name ?? e.email ?? '—'}</td>
						<td><span class="chip" style="background:{c[0]};color:{c[1]}">{e.event_type.replace('_', ' ')}</span></td>
						<td>{describe(e)}</td>
					</tr>
				{/each}
			</tbody>
		</table></div>
		<p class="adm-muted">Showing the latest {data.recent.length} events. Use the Logs tab for full history and exports.</p>
	{/if}
</div>

<style>
	.bar { display: flex; align-items: flex-end; gap: 14px; flex-wrap: wrap; margin-bottom: 14px; }
	.f { display: flex; flex-direction: column; gap: 3px; font-size: 11px; font-weight: 700; color: var(--grey-text); }
	.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
	.kpi { background: #F6F8FB; border: 1px solid var(--grey-line); border-radius: 10px; padding: 12px 14px; display: flex; flex-direction: column; gap: 2px; }
	.kl { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); }
	.kv { font-size: 24px; font-weight: 800; color: var(--navy); line-height: 1.2; }
	.kv.sm { font-size: 16px; }
	.ks { font-size: 11px; color: var(--grey-text); }
	.chart { display: flex; align-items: flex-end; gap: 6px; height: 140px; overflow-x: auto; padding-bottom: 18px; }
	.col { position: relative; flex: 1 0 22px; max-width: 48px; height: 100%; display: flex; align-items: flex-end; }
	.barfill { width: 100%; background: var(--orange); border-radius: 4px 4px 0 0; }
	.lbl { position: absolute; bottom: -16px; left: 50%; transform: translateX(-50%); font-size: 9px; color: var(--grey-text); white-space: nowrap; }
	.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
	.link { background: none; border: none; padding: 0; font: inherit; font-weight: 700; color: var(--navy); cursor: pointer; text-align: left; }
	.link:hover { text-decoration: underline; }
	.chip { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
	.pills { display: flex; gap: 6px; flex-wrap: wrap; }
	.pill { background: #fff; border: 1px solid var(--grey-line); border-radius: 99px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer; text-transform: capitalize; }
	.pill.active { background: var(--navy); border-color: var(--navy); color: #fff; }
	@media (max-width: 1000px) { .two { grid-template-columns: 1fr; } }
</style>
