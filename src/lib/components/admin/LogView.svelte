<script lang="ts">
	import type { LogEntry } from '$lib/server/admin/logs';
	export let entries: LogEntry[] = [];
	export let nextCursor: string | null = null;
	export let filters: Record<string, string> = {};
	export let action: string;
	export let showAccountFilter = true;
	export let showSourceFilter = true;

	$: nextHref = nextCursor
		? `${action}?${new URLSearchParams({ ...filters, cursor: nextCursor }).toString()}`
		: null;
	const pretty = (v: unknown) => JSON.stringify(v, null, 2);
</script>

<form method="GET" {action} class="adm-card" role="search" aria-label="Log filters">
	<div class="adm-row">
		{#if showSourceFilter}
			<label>Source
				<select name="source">
					{#each [['all', 'All'], ['error', 'Error log'], ['activity', 'Activity log'], ['audit', 'Admin audit']] as [v, l]}
						<option value={v} selected={(filters.source ?? 'all') === v}>{l}</option>
					{/each}
				</select>
			</label>
		{/if}
		<label>From (UTC)<input type="datetime-local" name="from" value={filters.from ?? ''} /></label>
		<label>To (UTC)<input type="datetime-local" name="to" value={filters.to ?? ''} /></label>
		<label>Severity
			<select name="severity">
				<option value="">Any</option>
				<option value="error" selected={filters.severity === 'error'}>error</option>
				<option value="warn" selected={filters.severity === 'warn'}>warn</option>
			</select>
		</label>
		<label>Operation / event<input name="event" value={filters.event ?? ''} /></label>
		<label>Actor user ID<input name="actor" value={filters.actor ?? ''} class="adm-mono" /></label>
		{#if showAccountFilter}
			<label>Account ID (or “unattributed”)<input name="account" value={filters.account ?? ''} class="adm-mono" /></label>
		{/if}
		<label>Request ID<input name="request" value={filters.request ?? ''} class="adm-mono" /></label>
		<label>Message contains<input name="q" value={filters.q ?? ''} /></label>
		<button class="adm-btn" type="submit">Filter</button>
	</div>
</form>

<div class="adm-card">
	{#if entries.length === 0}
		<div class="adm-empty">No log records match.</div>
	{:else}
		<div class="adm-table-wrap">
			<table class="adm-table">
				<caption class="adm-sr">Log records, newest first (UTC)</caption>
				<thead>
					<tr><th scope="col">Time (UTC)</th><th scope="col">Source</th><th scope="col">Sev.</th><th scope="col">Event</th><th scope="col">Message</th><th scope="col">Account</th></tr>
				</thead>
				<tbody>
					{#each entries as e (e.source + e.id)}
						<tr>
							<td class="adm-mono">{e.ts.replace('T', ' ').slice(0, 23)}</td>
							<td>{e.source}</td>
							<td>{e.severity ?? '—'}</td>
							<td>{e.event}{#if e.origin}<br /><span class="adm-muted">{e.origin}</span>{/if}</td>
							<td>
								<details>
									<summary>{(e.message ?? '(no message)').split('\n')[0].slice(0, 120)}</summary>
									<dl class="adm-kv" style="margin:8px 0">
										<dt>Record ID</dt><dd class="adm-mono">{e.source}/{e.id}</dd>
										<dt>Timestamp</dt><dd class="adm-mono">{e.ts}</dd>
										<dt>Actor</dt><dd class="adm-mono">{e.actorUserId ?? e.actorRef ?? '—'}</dd>
										<dt>Request ID</dt><dd class="adm-mono">{e.requestId ?? '—'}</dd>
										{#if e.code}<dt>Code</dt><dd>{e.code}</dd>{/if}
									</dl>
									{#if e.message}<pre class="adm-pre">{e.message}</pre>{/if}
									{#if e.stack}<p class="adm-muted">Stack</p><pre class="adm-pre">{e.stack}</pre>{/if}
									{#if e.details != null}<p class="adm-muted">Details (redacted)</p><pre class="adm-pre">{pretty(e.details)}</pre>{/if}
									{#each e.missing as m}<p class="adm-muted" style="font-size:12px">ⓘ {m}</p>{/each}
								</details>
							</td>
							<td class="adm-mono">{e.accountId ?? 'unattributed'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<nav class="adm-pager" aria-label="Pagination">
			<span>{entries.length} shown</span>
			{#if nextHref}<a class="adm-btn outline sm" href={nextHref}>Older →</a>{:else}<span class="adm-muted">End of retained records</span>{/if}
		</nav>
	{/if}
</div>
