<script lang="ts">
	import type { PageData } from './$types';
	import { page } from '$app/stores';
	import RowMenu from '$lib/components/admin/RowMenu.svelte';
	import FilePreviewModal from '$lib/components/files/FilePreviewModal.svelte';
	export let data: PageData;
	const size = (b: string) => (Number(b) > 1048576 ? (Number(b) / 1048576).toFixed(1) + ' MB' : Math.ceil(Number(b) / 1024) + ' KB');
	$: accountId = $page.params.accountId;
	type D = PageData['documents'][number];
	const FILTERS = [['all', 'All'], ['store', 'Store documents'], ['case', 'Case documents']] as const;
	let filter: (typeof FILTERS)[number][0] = 'all';
	let search = '';
	$: count = (f: string) => data.documents.filter((x) => f === 'all' || x.kind === f).length;
	$: list = data.documents.filter((x) => {
		const q = search.trim().toLowerCase();
		return (filter === 'all' || x.kind === filter) && (!q || [x.original_name, x.store_name, x.sfdc_case_id].join(' ').toLowerCase().includes(q));
	});
	const dl = (x: D) => `/admin/accounts/${accountId}/documents/${x.kind}/${x.id}/download`;
	const menu = (x: D) => [
		{ label: 'Preview', icon: '👁', run: () => preview(x) },
		{ label: 'Download', icon: '⬇', href: dl(x) }
	];
	let previewOpen = false;
	let pv = { name: '', mime: null as string | null, url: '', dl: '' };
	function preview(d: { kind: string; id: string; original_name: string; mime_type: string | null }) {
		const u = `/admin/accounts/${accountId}/documents/${d.kind}/${d.id}/download`;
		pv = { name: d.original_name, mime: d.mime_type, url: `${u}?disposition=inline`, dl: u };
		previewOpen = true;
	}
</script>

<svelte:head><title>Documents — Admin</title></svelte:head>
<div class="adm-card">
	<h2>Store &amp; case documents</h2>
	<p class="adm-muted">Previews and downloads are logged in the admin audit trail. Shows up to 500 most recent.</p>
	<div class="toolbar"><input type="search" class="adm-input search" placeholder="Search by file, store or case…" aria-label="Search documents" bind:value={search} /></div>
	<div class="pillbar">
		{#each FILTERS as [k, label]}<button type="button" class="pill" class:active={filter === k} on:click={() => (filter = k)}>{label} <span>{count(k)}</span></button>{/each}
		<span class="adm-muted foot">Showing {list.length} of {data.documents.length} documents</span>
	</div>
	{#if data.documents.length === 0}<div class="adm-empty">No documents.</div>{:else}
		<div class="adm-table-wrap"><table class="adm-table">
			<caption class="adm-sr">Documents</caption>
			<thead><tr><th scope="col">File</th><th scope="col">Type</th><th scope="col">Store</th><th scope="col">Case</th><th scope="col">Size</th><th scope="col">Uploaded</th><th scope="col"><span class="adm-sr">Actions</span></th></tr></thead>
			<tbody>
				{#each list as d (d.kind + d.id)}
					<tr>
						<td><button type="button" class="namelink" title="Preview" on:click={() => preview(d)}>{d.original_name}</button></td><td>{d.kind}</td><td>{d.store_name}</td><td class="adm-mono">{d.sfdc_case_id ?? '—'}</td>
						<td>{size(d.size_bytes)}</td><td>{new Date(d.created_at).toISOString().slice(0, 10)}</td>
						<td><RowMenu items={menu(d)} /></td>
					</tr>
				{/each}
			</tbody></table></div>
	{/if}
</div>

<FilePreviewModal bind:open={previewOpen} fileName={pv.name} mimeType={pv.mime} previewUrl={pv.url} downloadUrl={pv.dl} />

<style>
	.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
	.search { flex: 1; }
	.pillbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
	.pill { background: #fff; border: 1px solid var(--grey-line); border-radius: 99px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer; }
	.pill.active { background: var(--navy); border-color: var(--navy); color: #fff; }
	.pill span { opacity: .7; margin-left: 3px; }
	.foot { margin-left: auto; font-size: 12px; }
	.namelink { background: none; border: none; padding: 0; font: inherit; font-weight: 700; color: var(--navy); cursor: pointer; text-align: left; }
	.namelink:hover { text-decoration: underline; }
</style>
