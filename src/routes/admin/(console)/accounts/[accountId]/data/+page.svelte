<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import type { PageData } from './$types';
	export let data: PageData;

	type Col = { name: string; type: string; kind: 'text' | 'int' | 'bool' | 'date' };
	type Cond = { id: number; col: string; op: string; val: string; val2: string };

	$: base = `/admin/accounts/${$page.params.accountId}/data`;
	$: from = $page.url.searchParams.get('from');
	$: res = data.result;
	$: cols = (res.ok ? res.columns : []) as Col[];
	$: q = data.query;

	// ── URL state ──────────────────────────────────────────────────────
	function nav(patch: Record<string, string | null>, resetPage = true) {
		const p = new URLSearchParams($page.url.searchParams);
		for (const [k, v] of Object.entries(patch)) (v ? p.set(k, v) : p.delete(k));
		if (resetPage) p.delete('page');
		goto(`${base}?${p}`, { keepFocus: true, noScroll: true });
	}
	function selectTable(t: string) {
		const p = new URLSearchParams();
		p.set('table', t);
		if (from) p.set('from', from);
		goto(`${base}?${p}`, { noScroll: true });
		closeRow();
	}
	function sortBy(c: string) {
		const asc = q.sort === c && q.dir === 'desc';
		nav({ sort: c, dir: asc ? 'asc' : 'desc' });
	}
	let rowSearch = '';
	$: rowSearch = q.q;
	let searchTimer: ReturnType<typeof setTimeout>;
	function onSearch(v: string) {
		rowSearch = v;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => nav({ q: v.trim() || null }), 350);
	}

	// ── Table sidebar ──────────────────────────────────────────────────
	let tableSearch = '';
	$: groups = data.groups
		.map((g) => ({ ...g, items: g.items.filter((i) => !tableSearch.trim() || i.name.includes(tableSearch.trim().toLowerCase())) }))
		.filter((g) => g.items.length);

	// ── Row drawer ─────────────────────────────────────────────────────
	let openRow: Record<string, unknown> | null = null;
	let toast: string | null = null;
	function closeRow() { openRow = null; }
	function showToast(t: string) { toast = t; setTimeout(() => (toast = null), 2000); }
	async function copy(v: unknown) {
		if (v == null) return showToast('Nothing to copy');
		try { await navigator.clipboard.writeText(typeof v === 'object' ? JSON.stringify(v) : String(v)); showToast('Copied'); } catch { /* needs user gesture */ }
	}
	const cell = (c: Col, v: unknown) => {
		if (v === null || v === undefined) return { text: 'NULL', cls: 'null' };
		if (typeof v === 'boolean') return { text: String(v), cls: v ? 'yes' : 'no' };
		const text = typeof v === 'object' ? JSON.stringify(v) : String(v);
		return { text, cls: /uuid|int|timestamp|numeric/.test(c.type) || /_id$|^id$|hash|key|token|intent/.test(c.name) ? 'mono' : '' };
	};
	$: rowTitle = openRow ? String(openRow.name ?? openRow.email ?? openRow.display_name ?? openRow.id ?? 'Row') : '';

	// ── Filter dialog ──────────────────────────────────────────────────
	let showFilters = false;
	let draft: Cond[] = [];
	let draftLogic = '';
	let nextId = 1;
	let preview: { total: number; capped: boolean; error: string | null } | null = null;
	let previewTimer: ReturnType<typeof setTimeout>;

	const kindOfCol = (name: string) => cols.find((c) => c.name === name)?.kind ?? 'text';
	const kindLabel = { text: 'text', int: 'number', bool: 'boolean', date: 'date' };
	const incomplete = (c: Cond) => !data.noVal.includes(c.op) && (c.val === '' || (c.op === 'between' && c.val2 === ''));

	function openFilters() {
		draft = q.conds.map((c) => ({ id: nextId++, ...c }));
		draftLogic = q.logic;
		showFilters = true;
		refreshPreview();
	}
	function addCond() {
		const c = cols[0];
		if (!c) return;
		draft = [...draft, { id: nextId++, col: c.name, op: data.ops[c.kind][0][0], val: '', val2: '' }];
		refreshPreview();
	}
	function setCol(c: Cond, name: string) { c.col = name; c.op = data.ops[kindOfCol(name)][0][0]; c.val = ''; c.val2 = ''; draft = draft; refreshPreview(); }
	function removeCond(id: number) { draft = draft.filter((c) => c.id !== id); draftLogic = ''; refreshPreview(); }
	function clearDraft() { draft = []; draftLogic = ''; refreshPreview(); }

	function refreshPreview() {
		clearTimeout(previewTimer);
		previewTimer = setTimeout(async () => {
			const p = new URLSearchParams({ table: data.table, count: '1' });
			if (draft.length) p.set('f', JSON.stringify(draft.map(({ col, op, val, val2 }) => ({ col, op, val, val2 }))));
			if (draftLogic.trim()) p.set('logic', draftLogic.trim());
			if (q.q) p.set('q', q.q);
			try { preview = await (await fetch(`${base}/export?${p}`)).json(); } catch { preview = null; }
		}, 300);
	}

	// Client-side logic validation (mirrors the server) for instant feedback.
	function checkLogic(str: string, n: number): { err: string | null; unused: number[] } {
		if (!str.trim()) return { err: null, unused: [] };
		const toks = str.toUpperCase().match(/\d+|AND|OR|NOT|\(|\)|\S+/g) ?? [];
		let i = 0; const used = new Set<number>();
		const factor = (): void => {
			const t = toks[i];
			if (t === 'NOT') { i++; return factor(); }
			if (t === '(') { i++; expr(); if (toks[i] !== ')') throw new Error(i < toks.length ? `Expected ) near “${toks[i]}”` : 'Expected ) at end'); i++; return; }
			if (t && /^\d+$/.test(t)) { const k = Number(t); if (k < 1 || k > n) throw new Error(`Condition ${k} doesn’t exist`); used.add(k); i++; return; }
			throw new Error(t ? `Unexpected “${t}”` : 'Expression ends too early');
		};
		const term = () => { factor(); while (toks[i] === 'AND') { i++; factor(); } };
		const expr = () => { term(); while (toks[i] === 'OR') { i++; term(); } };
		try { expr(); if (i < toks.length) throw new Error(`Unexpected “${toks[i]}”`); }
		catch (e) { return { err: (e as Error).message, unused: [] }; }
		return { err: null, unused: Array.from({ length: n }, (_, k) => k + 1).filter((k) => !used.has(k)) };
	}
	$: lcheck = checkLogic(draftLogic, draft.length);
	$: defLogic = draft.map((_, k) => k + 1).join(' AND ');
	$: chips = ['(', ')', 'AND', 'OR', 'NOT', ...draft.map((_, k) => String(k + 1))];
	function insert(tok: string) { draftLogic = (draftLogic.trim() ? draftLogic.trim() + ' ' : '') + tok; refreshPreview(); }
	function apply() {
		// Send every condition (incomplete ones are ignored server-side) so the logic numbers stay aligned.
		const f = draft.map(({ col, op, val, val2 }) => ({ col, op, val, val2 }));
		showFilters = false;
		nav({ f: f.length ? JSON.stringify(f) : null, logic: f.length > 1 && draftLogic.trim() ? draftLogic.trim() : null });
	}
	function clearApplied() { nav({ f: null, logic: null }); }

	$: exportUrl = (() => {
		const p = new URLSearchParams({ table: data.table });
		if (q.q) p.set('q', q.q);
		if (q.conds.length) p.set('f', JSON.stringify(q.conds));
		if (q.logic) p.set('logic', q.logic);
		if (q.sort) { p.set('sort', q.sort); p.set('dir', q.dir); }
		return `${base}/export?${p}`;
	})();

	$: totalPages = res.ok ? Math.max(1, Math.ceil(res.total / data.pageSize)) : 1;
	$: summaryLogic = q.logic.trim() || q.conds.map((_, k) => k + 1).join(' AND ');
</script>

<svelte:head><title>Account data — Admin</title></svelte:head>
<svelte:window on:keydown={(e) => { if (e.key === 'Escape') { if (showFilters) showFilters = false; else closeRow(); } }} />

<div class="adm-alert info"><span aria-hidden="true">ℹ</span> Rows below are linked to <strong>this account</strong> through the relationship shown for each table. Global or unrelated tables ({data.globalTables.join(', ')}) are only in the <a href="/admin/data">global data explorer</a>.</div>

<div class="wrap">
	<aside>
		<div class="aside-head">Tables <span class="cnt">{data.tableCount}</span></div>
		<input type="search" class="adm-input" placeholder="Filter tables…" aria-label="Filter tables" bind:value={tableSearch} />
		<div class="groups">
			{#each groups as g}
				<div>
					<div class="gtitle">{g.title}</div>
					{#each g.items as t}
						<button type="button" class="tbtn" class:on={t.name === data.table} aria-current={t.name === data.table ? 'page' : undefined} on:click={() => selectTable(t.name)}>
							<span class="tname">{t.name}</span><span class="tcount" class:zero={!t.count}>{t.count > 10000 ? '10k+' : t.count}</span>
						</button>
					{/each}
				</div>
			{/each}
		</div>
	</aside>

	<section class="panel">
		<div class="phead">
			<div>
				<div class="ptitle">
					<h2>{data.table}</h2>
					{#if res.ok}<span class="rows">{res.total}{res.capped ? '+' : ''} row{res.total === 1 ? '' : 's'}</span>{/if}
					<span class="ro">Read-only</span>
				</div>
				{#if res.ok}<div class="rel">Relationship <code>{res.relationship}</code></div>{/if}
			</div>
			<div class="tools">
				<input type="search" class="adm-input" placeholder="Search all fields…" aria-label="Search all fields" value={rowSearch} on:input={(e) => onSearch(e.currentTarget.value)} />
				<button type="button" class="adm-btn outline" aria-haspopup="dialog" on:click={openFilters}>⚲ Filters{#if q.conds.length}<span class="badge">{q.conds.length}</span>{/if}</button>
				<a class="adm-btn outline" class:disabled={!res.ok || res.total === 0} href={exportUrl} data-sveltekit-reload title="Exports the rows currently matching search, filters and sort (max 50,000)">⤓ Export {res.ok ? res.total : ''}</a>
			</div>
		</div>

		{#if q.conds.length}
			<div class="summary">
				<span class="muted">Filtered:</span> <code>{summaryLogic}</code>
				<span class="muted">· {q.conds.length} condition{q.conds.length === 1 ? '' : 's'}</span>
				<span style="flex:1"></span>
				<button type="button" class="lnk" on:click={openFilters}>Edit</button>
				<button type="button" class="lnk" on:click={clearApplied}>Clear</button>
			</div>
		{/if}

		{#if !res.ok}
			<div class="adm-alert warn">{res.reason}</div>
		{:else}
			{#if res.filterError}<div class="adm-alert error">Filter logic error: {res.filterError} — filters not applied.</div>{/if}
			{#if res.hidden.length}<div class="adm-alert warn">Sensitive columns ({res.hidden.join(', ')}) are redacted in this view.</div>{/if}
			<div class="tablewrap" role="region" tabindex="0" aria-label={data.table}>
				<table class="adm-table">
					<thead>
						<tr>
							{#each cols as c}
								<th scope="col" aria-sort={q.sort === c.name ? (q.dir === 'asc' ? 'ascending' : 'descending') : 'none'} title="Sort by {c.name}" on:click={() => sortBy(c.name)}>
									<span class="cn">{c.name}<span class="arrow">{q.sort === c.name ? (q.dir === 'asc' ? '▲' : '▼') : '↕'}</span></span>
									<span class="ct">{c.type}</span>
								</th>
							{/each}
						</tr>
					</thead>
					<tbody>
						{#each res.rows as r, i}
							<tr class:alt={i % 2} class:sel={openRow === r} title="Open record" on:click={() => (openRow = r)}>
								{#each cols as c}
									{@const v = cell(c, r[c.name])}
									<td class={v.cls}>{v.text}</td>
								{/each}
							</tr>
						{/each}
					</tbody>
				</table>
				{#if res.rows.length === 0}
					<div class="adm-empty">{q.conds.length || q.q ? 'No rows match your search and filters.' : 'No rows for this account.'}</div>
				{/if}
			</div>
			<nav class="pager" aria-label="Pagination">
				<span class="muted">{res.total ? `Rows ${(data.page - 1) * data.pageSize + 1}–${Math.min(res.total, data.page * data.pageSize)} of ${res.total}${res.capped ? '+' : ''}` : '0 rows'} · Page {data.page} of {totalPages}</span>
				<span class="pbtns">
					<button type="button" class="adm-btn outline sm" disabled={data.page <= 1} on:click={() => nav({ page: String(data.page - 1) }, false)}>← Prev</button>
					<button type="button" class="adm-btn outline sm" disabled={data.page >= totalPages} on:click={() => nav({ page: String(data.page + 1) }, false)}>Next →</button>
				</span>
			</nav>
		{/if}
	</section>
</div>

<!-- Row detail drawer -->
{#if openRow}
	<div class="scrim" role="presentation" on:click={closeRow}></div>
	<aside class="drawer" role="dialog" aria-modal="true" aria-label="Row detail">
		<header>
			<div><div class="dk">Row · {data.table}</div><div class="dt">{rowTitle}</div></div>
			<div class="dbtns">
				<button type="button" class="adm-btn outline sm" on:click={() => copy(openRow)}>Copy JSON</button>
				<button type="button" class="x" aria-label="Close" on:click={closeRow}>✕</button>
			</div>
		</header>
		<div class="dbody">
			{#each cols as c}
				{@const v = cell(c, openRow[c.name])}
				<div class="field">
					<span class="fname">{c.name}</span>
					<button type="button" class="fval {v.cls}" title="Click to copy" on:click={() => copy(openRow?.[c.name])}>{v.text}</button>
				</div>
			{/each}
			{#if res.ok && res.hidden.length}
				{#each res.hidden as h}<div class="field"><span class="fname">{h}</span><span class="fval red">•••••• redacted</span></div>{/each}
			{/if}
		</div>
	</aside>
{/if}

<!-- Filter dialog -->
{#if showFilters}
	<div class="backdrop" role="presentation" on:click={() => (showFilters = false)}>
		<div class="modal" role="dialog" aria-modal="true" aria-label="Filter rows" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
			<header>
				<div><div class="mt"><h3>Filter rows</h3><code>{data.table}</code></div><div class="muted">Build numbered conditions, then combine them with filter logic.</div></div>
				<button type="button" class="x" aria-label="Close" on:click={() => (showFilters = false)}>✕</button>
			</header>
			<div class="mbody">
				<div class="ch"><span class="lbl">Conditions</span><span class="muted">{draft.length} of 12</span></div>
				{#each draft as c, k (c.id)}
					{@const kind = kindOfCol(c.col)}
					{@const needs = !data.noVal.includes(c.op)}
					<div class="cond" class:warn={incomplete(c)}>
						<span class="num" class:inc={incomplete(c)} title={incomplete(c) ? 'Incomplete — ignored' : `Condition ${k + 1}`}>{k + 1}</span>
						<div class="cgrid">
							<label><span class="lbl">Column</span>
								<select class="adm-input" value={c.col} on:change={(e) => setCol(c, e.currentTarget.value)}>
									{#each cols as x}<option value={x.name}>{x.name}  ·  {x.type}</option>{/each}
								</select></label>
							<label><span class="lbl">Operator <span class="muted">· {kindLabel[kind]}</span></span>
								<select class="adm-input" bind:value={c.op} on:change={() => { draft = draft; refreshPreview(); }}>
									{#each data.ops[kind] as [v, label]}<option value={v}>{label}</option>{/each}
								</select></label>
							<div><span class="lbl">{c.op === 'between' ? 'Range' : c.op === 'lastn' ? 'Days' : 'Value'}</span>
								<div class="vals">
									{#if needs}
										<input class="adm-input" type={kind === 'int' || c.op === 'lastn' ? 'number' : kind === 'date' ? 'date' : 'text'} bind:value={c.val} placeholder={c.op === 'lastn' ? 'days' : 'value'} aria-label="Value" on:input={refreshPreview} />
									{:else}<span class="muted">No value needed</span>{/if}
									{#if c.op === 'between'}<span class="muted">to</span>
										<input class="adm-input" type={kind === 'date' ? 'date' : 'number'} bind:value={c.val2} aria-label="Second value" on:input={refreshPreview} />{/if}
								</div></div>
						</div>
						<button type="button" class="x" aria-label="Remove condition {k + 1}" title="Remove" on:click={() => removeCond(c.id)}>✕</button>
					</div>
				{:else}
					<div class="adm-empty">No conditions yet — add one to start filtering.</div>
				{/each}
				<button type="button" class="addc" disabled={draft.length >= 12} on:click={addCond}>+ Add condition</button>

				{#if draft.length > 1}
					<div class="logic">
						<div class="ch"><span class="lbl">Filter logic</span>
							{#if draftLogic.trim()}<button type="button" class="lnk" on:click={() => { draftLogic = ''; refreshPreview(); }}>Reset to default</button>{/if}</div>
						<input class="adm-input mono-in" class:bad={!!lcheck.err} bind:value={draftLogic} placeholder={defLogic} aria-label="Filter logic" spellcheck="false" on:input={refreshPreview} />
						<div class="chips"><span class="muted">Insert</span>{#each chips as t}<button type="button" on:click={() => insert(t)}>{t}</button>{/each}</div>
						<div class="lmsg" class:bad={!!lcheck.err}>
							{#if lcheck.err}✕ {lcheck.err} — filters not applied.
							{:else if draftLogic.trim()}✓ Valid: {draftLogic.trim().toUpperCase().replace(/\s+/g, ' ')}
							{:else}✓ Default: all conditions must match ({defLogic}). Use AND, OR, NOT and parentheses, e.g. 1 AND (2 OR 3).{/if}
							{#if lcheck.unused.length} · Not used: {lcheck.unused.join(', ')}{/if}
						</div>
					</div>
				{/if}
			</div>
			<footer>
				<div class="pv"><span class="dot" class:bad={preview?.error || lcheck.err}></span>
					<span><strong>{preview && !preview.error ? `${preview.total}${preview.capped ? '+' : ''}` : '—'}</strong> <span class="muted">matching row{preview?.total === 1 ? '' : 's'}</span></span></div>
				<div class="fbtns">
					{#if draft.length}<button type="button" class="lnk red" on:click={clearDraft}>Clear all</button>{/if}
					<button type="button" class="adm-btn outline" on:click={() => (showFilters = false)}>Cancel</button>
					<button type="button" class="adm-btn" disabled={!!lcheck.err} on:click={apply}>Apply filters</button>
				</div>
			</footer>
		</div>
	</div>
{/if}

{#if toast}<div class="toast">{toast}</div>{/if}

<style>
	.wrap { display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 16px; align-items: start; }
	aside:not(.drawer) { background: #fff; border: 1px solid var(--grey-line); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 10px; position: sticky; top: 12px; max-height: calc(100vh - 40px); }
	.aside-head { display: flex; align-items: center; justify-content: space-between; font-size: 13px; font-weight: 800; color: var(--navy); }
	.cnt { font-size: 11px; background: #EEF2F8; border-radius: 99px; padding: 1px 8px; }
	.groups { overflow-y: auto; display: flex; flex-direction: column; gap: 10px; }
	.gtitle { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; color: var(--grey-text); padding: 4px 6px; }
	.tbtn { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 8px; background: #fff; border: none; border-left: 3px solid transparent; border-radius: 6px; padding: 6px 8px; font: inherit; font-size: 12px; color: var(--navy); cursor: pointer; text-align: left; }
	.tbtn:hover { background: #F6F8FB; }
	.tbtn.on { background: #FFF4DC; border-left-color: var(--orange); font-weight: 700; }
	.tname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.tcount { font-size: 11px; color: var(--grey-text); } .tcount.zero { color: #B8C0CC; }
	.panel { background: #fff; border: 1px solid var(--grey-line); border-radius: 12px; padding: 16px 18px; min-width: 0; }
	.phead { display: flex; justify-content: space-between; gap: 14px; flex-wrap: wrap; margin-bottom: 12px; }
	.ptitle { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
	.ptitle h2 { margin: 0; font-size: 18px; }
	.rows { font-size: 12px; color: var(--grey-text); }
	.ro { font-size: 10px; font-weight: 800; text-transform: uppercase; letter-spacing: .05em; background: #FEF3C7; color: #92400e; border-radius: 99px; padding: 2px 8px; }
	.rel { font-size: 12px; color: var(--grey-text); margin-top: 4px; }
	code { background: #F1F4F9; padding: 1px 6px; border-radius: 5px; font-size: 11px; }
	.tools { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
	.tools .adm-input { min-width: 220px; }
	.badge { background: var(--navy); color: #fff; border-radius: 99px; font-size: 10px; padding: 0 6px; }
	.disabled { opacity: .5; pointer-events: none; }
	.summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; background: #FFFBEB; border: 1px solid #fcd34d; border-radius: 8px; padding: 8px 12px; font-size: 12px; margin-bottom: 12px; }
	.muted { color: var(--grey-text); font-size: 12px; }
	.lnk { background: none; border: none; padding: 0; font: inherit; font-size: 12px; font-weight: 700; color: var(--navy); cursor: pointer; text-decoration: underline; }
	.lnk.red:hover { color: #b91c1c; }
	.tablewrap { overflow: auto; max-height: 62vh; border: 1px solid var(--grey-line); border-radius: 8px; }
	.tablewrap :global(.adm-table) { white-space: nowrap; }
	th { cursor: pointer; position: sticky; top: 0; background: #fafbfd; z-index: 1; }
	th:hover { background: #EEF2F7; }
	.cn { display: block; } .arrow { margin-left: 4px; font-size: 9px; color: var(--grey-text); }
	.ct { display: block; font-size: 9px; font-weight: 500; text-transform: none; letter-spacing: 0; color: #9AA5BC; }
	tbody tr { cursor: pointer; } tbody tr:hover { background: #FFF8E6; } tbody tr.alt { background: #FCFDFE; } tbody tr.sel { background: #FFF4DC; }
	td { max-width: 320px; overflow: hidden; text-overflow: ellipsis; }
	td.mono, .fval.mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
	td.null, .fval.null { color: #B8C0CC; font-style: italic; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
	td.yes, .fval.yes { color: #15803d; font-family: ui-monospace, Menlo, monospace; font-size: 12px; } td.no, .fval.no { color: #b91c1c; font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
	.pager { display: flex; justify-content: space-between; align-items: center; margin-top: 12px; flex-wrap: wrap; gap: 8px; }
	.pbtns { display: flex; gap: 8px; }
	.scrim { position: fixed; inset: 0; background: rgba(15,23,42,.35); z-index: 1100; }
	.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(520px, 100%); background: #fff; z-index: 1110; box-shadow: -12px 0 40px rgba(0,0,0,.18); display: flex; flex-direction: column; }
	.drawer header, .modal header { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--grey-line); }
	.dk { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--grey-text); } .dt { font-size: 16px; font-weight: 800; color: var(--navy); word-break: break-all; }
	.dbtns { display: flex; gap: 8px; align-items: center; }
	.dbody { overflow-y: auto; padding: 8px 18px 24px; }
	.field { display: flex; flex-direction: column; gap: 2px; padding: 10px 0; border-bottom: 1px solid var(--grey-line); }
	.fname { font-size: 11px; font-weight: 700; color: var(--grey-text); font-family: ui-monospace, Menlo, monospace; }
	.fval { background: none; border: none; padding: 0; text-align: left; font: inherit; font-size: 13px; color: var(--navy); cursor: pointer; word-break: break-word; }
	.fval:hover { text-decoration: underline; } .fval.red { color: #92400e; font-style: italic; cursor: default; }
	.x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); line-height: 1; }
	.backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.55); z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 24px; }
	.modal { background: #fff; border-radius: 12px; width: min(820px, 100%); max-height: 90vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.25); }
	.mt { display: flex; align-items: center; gap: 8px; } .mt h3 { margin: 0; font-size: 16px; }
	.mbody { padding: 16px 20px; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; background: #F6F8FB; }
	.ch { display: flex; justify-content: space-between; align-items: center; }
	.lbl { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--grey-text); }
	.cond { display: flex; gap: 10px; align-items: flex-start; background: #fff; border: 1px solid var(--grey-line); border-radius: 10px; padding: 12px; }
	.cond.warn { border-color: #fcd34d; }
	.num { width: 24px; height: 24px; flex-shrink: 0; border-radius: 50%; background: var(--navy); color: #fff; font-size: 12px; font-weight: 800; display: flex; align-items: center; justify-content: center; }
	.num.inc { background: #F1F5F9; color: var(--grey-text); }
	.cgrid { flex: 1; display: grid; grid-template-columns: 1.2fr 1fr 1.4fr; gap: 10px; min-width: 0; }
	.cgrid label, .cgrid > div { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
	.vals { display: flex; gap: 6px; align-items: center; } .vals .adm-input { flex: 1; min-width: 0; }
	.addc { align-self: flex-start; background: #fff; border: 1.5px dashed var(--grey-line); border-radius: 8px; padding: 7px 14px; font: inherit; font-size: 13px; font-weight: 700; color: var(--grey-text); cursor: pointer; }
	.addc:hover:not(:disabled) { border-color: var(--orange); color: var(--orange); }
	.logic { background: #fff; border: 1px solid var(--grey-line); border-radius: 10px; padding: 14px; }
	.mono-in { width: 100%; font-family: ui-monospace, Menlo, monospace; font-size: 14px; box-sizing: border-box; } .mono-in.bad { border-color: #fca5a5; }
	.chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 8px; }
	.chips button { min-width: 30px; padding: 3px 9px; font-family: ui-monospace, Menlo, monospace; font-size: 12px; font-weight: 700; border-radius: 6px; cursor: pointer; background: #fff; border: 1px solid var(--grey-line); color: var(--navy); }
	.chips button:hover { border-color: var(--orange); }
	.lmsg { margin-top: 10px; font-size: 12px; color: #166534; } .lmsg.bad { color: #b91c1c; }
	.modal footer { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--grey-line); }
	.pv { display: flex; align-items: center; gap: 8px; font-size: 13px; } .dot { width: 8px; height: 8px; border-radius: 50%; background: #22C55E; } .dot.bad { background: #EF4444; }
	.fbtns { display: flex; gap: 8px; align-items: center; }
	.toast { position: fixed; bottom: 24px; right: 24px; background: var(--navy-dark); color: #fff; padding: 12px 18px; border-radius: 10px; font-size: 13px; z-index: 9999; }
	@media (max-width: 1000px) { .wrap { grid-template-columns: 1fr; } .cgrid { grid-template-columns: 1fr; } }
</style>
