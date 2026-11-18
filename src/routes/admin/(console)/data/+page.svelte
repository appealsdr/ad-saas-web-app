<script lang="ts">
	import TableGrid from '$lib/components/admin/TableGrid.svelte';
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;

	// ── Write SQL (insert / update / delete) ───────────────────────────
	let wOp: 'insert' | 'update' | 'delete' = 'update';
	let wSql = '';
	let wReason = '';
	let wBusy = false;
	$: wTable = data.table;
	$: wCan = data.sqlConsole.enabled && data.sqlConsole.writable.includes(wTable);
	$: pv = form && 'preview' in form && form.preview && form.preview.sql === wSql.trim().replace(/;\s*$/, '').trim() && form.preview.table === wTable && form.preview.op === wOp ? form.preview : null;
	const TPL = {
		insert: (t: string) => `INSERT INTO ${t} (col1, col2) VALUES ('value1', 'value2')`,
		update: (t: string) => `UPDATE ${t} SET col1 = 'value' WHERE id = '<uuid>'`,
		delete: (t: string) => `DELETE FROM ${t} WHERE id = '<uuid>'`
	};

	let query = 'SELECT a.name, count(u.id) AS users\nFROM accounts a\nLEFT JOIN users u ON u.account_id = a.id\nGROUP BY a.name\nORDER BY users DESC\nLIMIT 50';
	let maxRows = 500;
	let running = false;
	let error = '';
	let out: null | {
		columns: { name: string; type: string }[]; rows: Record<string, unknown>[]; rowCount: number;
		truncated: boolean; truncatedBy: string | null; elapsedMs: number; scope: string;
	} = null;

	async function run() {
		running = true; error = ''; out = null;
		try {
			const res = await fetch('/admin/data/query', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ query, maxRows })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) error = body.message ?? `Request failed (${res.status})`;
			else out = body;
		} catch {
			error = 'Network error — the query may not have run.';
		} finally {
			running = false;
		}
	}

	$: t = data.table;
	const href = (name: string, extra = '') => `/admin/data?table=${name}${extra}`;
	$: pageHref = (p: number) => href(t, `&page=${p}${data.sort ? '&sort=' + data.sort + '&dir=' + data.dir : ''}${data.fcol ? '&fcol=' + data.fcol + '&fval=' + encodeURIComponent(data.fval) : ''}`);
	$: current = data.inventory.find((i) => i.name === t);
</script>

<svelte:head><title>Data &amp; SQL — Admin</title></svelte:head>
<h1 class="adm-h1">Data explorer <span class="adm-muted" style="font-size:13px">· All customers</span></h1>
<p class="adm-sub">Every application table is listed. Readable tables are reviewed, secret-free projections; others are metadata-only.</p>

<div class="adm-split">
	<nav class="adm-side" aria-label="Tables">
		{#each data.inventory as i}
			<a href={href(i.name)} aria-current={i.name === t ? 'page' : undefined}><span>{i.name}</span><span class="adm-muted">{i.readable ? '' : 'metadata'}</span></a>
		{/each}
	</nav>
	<div>
		<div class="adm-card">
			<h2>{t}</h2>
			{#if current}<p class="adm-muted">{current.note}{#if !current.reviewed} <strong>(unreviewed)</strong>{/if}</p>{/if}
			<details>
				<summary>Columns ({data.columns.length})</summary>
				<table class="adm-table"><thead><tr><th scope="col">Column</th><th scope="col">Type</th><th scope="col">Key</th><th scope="col">Readable</th></tr></thead>
					<tbody>{#each data.columns as c}<tr><td class="adm-mono">{c.name}</td><td>{c.type}{c.nullable ? '' : ' not null'}</td><td>{c.isPrimaryKey ? 'PK' : ''}{c.references ? ` → ${c.references}` : ''}</td><td>{c.readable ? 'yes' : 'hidden'}</td></tr>{/each}</tbody></table>
			</details>
			{#if data.result.ok}
				<form method="GET" class="adm-row" style="margin-top:12px">
					<input type="hidden" name="table" value={t} />
					<label>Filter column
						<select name="fcol"><option value="">—</option>{#each data.result.columns as c}<option value={c} selected={c === data.fcol}>{c}</option>{/each}</select>
					</label>
					<label>Contains<input name="fval" value={data.fval} /></label>
					<label>Sort
						<select name="sort"><option value="">—</option>{#each data.result.columns as c}<option value={c} selected={c === data.sort}>{c}</option>{/each}</select>
					</label>
					<label>Order<select name="dir"><option value="desc" selected={data.dir === 'desc'}>desc</option><option value="asc" selected={data.dir === 'asc'}>asc</option></select></label>
					<button class="adm-btn sm" type="submit">Apply</button>
				</form>
				<p class="adm-muted">{data.result.total}{data.result.capped ? '+' : ''} row(s) · {data.result.scope}</p>
				{#if data.result.rows.length === 0}<div class="adm-empty">No rows.</div>{:else}
					<TableGrid columns={data.result.columns.map((c) => ({ name: c }))} rows={data.result.rows} caption={t} />
					<nav class="adm-pager" aria-label="Pagination"><span>Page {data.page}</span>
						<span style="display:flex;gap:8px">
							{#if data.page > 1}<a class="adm-btn outline sm" href={pageHref(data.page - 1)}>← Previous</a>{/if}
							{#if data.page * 50 < data.result.total}<a class="adm-btn outline sm" href={pageHref(data.page + 1)}>Next →</a>{/if}
						</span></nav>
				{/if}
			{:else}
				<div class="adm-alert warn" style="margin-top:12px">{data.result.reason}</div>
			{/if}
		</div>

		<div class="adm-card">
			<h2>Inline SQL <span class="adm-muted" style="font-size:12px">· read-only · All customers</span></h2>
			<div class="adm-alert warn">Queries run across <strong>all customers</strong> — nothing is tenant-scoped automatically. Only SELECT against the reporting views listed on the left is allowed; 5 s timeout, up to 1,000 rows / 2 MB.</div>
			{#if !data.canQuery}
				<div class="adm-alert info">Your role (viewer) cannot run SQL.</div>
			{:else if !data.readerConfigured}
				<div class="adm-alert error" role="alert">Inline SQL is not configured: <code>ADMIN_READONLY_DATABASE_URL</code> is not set. See docs/admin-runbook.md. The rest of the admin area works normally.</div>
			{:else}
				<label class="adm-sr" for="sql">SQL query</label>
				<textarea id="sql" class="adm-textarea" bind:value={query} spellcheck="false" rows="8"></textarea>
				<div class="adm-row" style="margin-top:8px">
					<label>Rows <select bind:value={maxRows}><option value={500}>500</option><option value={1000}>1,000 (max)</option></select></label>
					<button class="adm-btn" type="button" on:click={run} disabled={running}>{running ? 'Running…' : 'Run'}</button>
				</div>
				{#if error}<div class="adm-alert error" role="alert">{error}</div>{/if}
				{#if out}
					<p class="adm-muted" role="status">{out.rowCount} row(s) · {out.elapsedMs} ms · {out.scope}{#if out.truncated} · <strong>truncated ({out.truncatedBy === 'bytes' ? '2 MB limit' : 'row limit'})</strong>{/if}</p>
					{#if out.rows.length === 0}<div class="adm-empty">Query returned no rows.</div>{:else}
						<TableGrid columns={out.columns} rows={out.rows} caption="Query results" />
					{/if}
				{/if}
			{/if}
		</div>

		{#if data.sqlConsole.enabled}
			<div class="adm-card">
				<h2>Write SQL <span class="adm-muted" style="font-size:12px">· insert / update / delete · <span class="adm-mono">{wTable}</span></span></h2>
				{#if form && 'sqlOk' in form && form.sqlOk}<div class="adm-alert ok" role="status">{form.sqlOk}</div>{/if}
				{#if form && 'sqlError' in form && form.sqlError}<div class="adm-alert error" role="alert">{form.sqlError}</div>{/if}
				{#if !wCan}
					<div class="adm-alert info">The selected table cannot be modified here. Select one of: {data.sqlConsole.writable.join(', ')}.</div>
				{:else}
					<div class="adm-alert warn">Runs <strong>one</strong> statement against <span class="adm-mono">{wTable}</span> for <strong>all customers</strong> — include a precise <code>WHERE</code>. Preview runs it in a rolled-back transaction and shows the affected rows. Execute needs a reason and recent MFA, is limited to {data.sqlConsole.maxRows} rows and is audited with the full statement.</div>
					<form method="POST" use:enhance={() => { wBusy = true; return async ({ update }) => { await update({ reset: false }); wBusy = false; }; }}>
						<input type="hidden" name="table" value={wTable} />
						<input type="hidden" name="op" value={wOp} />
						<div class="adm-row">
							{#each ['insert', 'update', 'delete'] as o}<label><input type="radio" bind:group={wOp} value={o} /> {o.toUpperCase()}</label>{/each}
							<button type="button" class="adm-btn" on:click={() => (wSql = TPL[wOp](wTable))}>Insert template</button>
						</div>
						<textarea name="sql" class="adm-textarea" rows="4" spellcheck="false" placeholder={TPL[wOp](wTable)} bind:value={wSql}></textarea>
						<div class="adm-row" style="margin-top:8px">
							<button class="adm-btn" type="submit" formaction="?/sqlPreview" disabled={wBusy || !wSql.trim()}>Preview (rolled back)</button>
							{#if pv}<strong>Would affect {pv.rows} row(s).</strong>{/if}
						</div>
						{#if pv}
							<input type="hidden" name="expectedRows" value={pv.rows} />
							<label style="display:block;margin-top:8px">Reason (required, 5–500 characters)
								<input class="adm-input" name="reason" bind:value={wReason} minlength="5" maxlength="500" />
							</label>
							<button class="adm-btn" type="submit" formaction="?/sqlRun" style="margin-top:8px" disabled={wBusy || wReason.trim().length < 5}>Execute {wOp.toUpperCase()} ({pv.rows} rows)</button>
						{/if}
					</form>
				{/if}
			</div>
		{/if}
	</div>
</div>
