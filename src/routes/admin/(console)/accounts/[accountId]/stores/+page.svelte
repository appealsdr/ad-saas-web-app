<script lang="ts">
	import { page } from '$app/stores';
	import RowMenu from '$lib/components/admin/RowMenu.svelte';
	import RecordModal from '$lib/components/admin/RecordModal.svelte';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;

	type Store = PageData['stores'][number];
	const fmt = (d: Date | string | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '');
	const SP: Record<string, [string, string, string]> = {
		connected: ['Connected', '#DCFCE7', '#15803d'], disconnected: ['Disconnected', '#F1F5F9', '#475569'], error: ['Error', '#FEE2E2', '#b91c1c']
	};
	const spKey = (s: Store) => (s.spapi_status === 'connected' ? 'connected' : s.spapi_status === 'error' || s.spapi_last_error ? 'error' : 'disconnected');
	const SF = { synced: ['Synced', '#DCFCE7', '#15803d'], not_in_sf: ['Not in Salesforce', '#FEE2E2', '#b91c1c'], unknown: ['Unknown', '#FEF3C7', '#92400e'] } as const;
	const FILTERS = [['all', 'All'], ['connected', 'Connected'], ['disconnected', 'Disconnected'], ['error', 'Error'], ['sf', 'Not in Salesforce']] as const;

	let filter: (typeof FILTERS)[number][0] = 'all';
	let search = '';
	let modal: { kind: 'create' | 'sync' | 'delete'; store: Store } | null = null;

	$: base = `/admin/accounts/${$page.params.accountId}`;
	const matches = (s: Store, f: string) => f === 'all' || (f === 'sf' ? s.sfState !== 'synced' : spKey(s) === f);
	$: count = (f: string) => data.stores.filter((s) => matches(s, f)).length;
	$: list = data.stores.filter((s) => {
		const q = search.trim().toLowerCase();
		return matches(s, filter) && (!q || [s.name, s.id, s.seller_id, s.sfdc_store_id, s.marketplaces].join(' ').toLowerCase().includes(q));
	});
	const mps = (s: Store) => (s.marketplaces ?? '').split(/[;,]/).map((x) => x.trim()).filter(Boolean);
	function menu(s: Store) {
		return [
			{ label: 'View', icon: '👁', href: `${base}/records/store/${s.id}` },
			{ label: 'Edit', icon: '✏️', href: data.canEdit ? `${base}/records/store/${s.id}?edit=1` : undefined, disabled: !data.canEdit, title: data.canEdit ? undefined : 'Your role is read-only' },
			{ label: 'Create in Salesforce', icon: '＋', disabled: !data.canSync || s.sfState !== 'not_in_sf', title: s.sfState === 'synced' ? 'Already in Salesforce — use Sync to update it' : s.sfState === 'unknown' ? 'Salesforce could not be reached' : undefined, run: () => (modal = { kind: 'create', store: s }) },
			{ label: 'Sync to Salesforce', icon: '🔄', disabled: !data.canSync || s.sfState !== 'synced', title: s.sfState === 'synced' ? undefined : 'Not in Salesforce yet — create it first', run: () => (modal = { kind: 'sync', store: s }) },
			{ label: 'View in Salesforce', icon: '↗', href: s.sfUrl ?? undefined, disabled: !s.sfUrl, title: s.sfUrl ? undefined : 'No linked Salesforce record' },
			{ label: 'Delete', icon: '🗑', danger: true, disabled: !data.canDelete, title: data.canDelete ? undefined : 'Your role cannot delete', run: () => (modal = { kind: 'delete', store: s }) }
		];
	}
</script>

<svelte:head><title>Stores — Admin</title></svelte:head>

{#if form && 'ok' in form && form.ok}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'error' in form && form.error && !modal}<div class="adm-alert error" role="alert">{form.error}</div>{/if}
{#if $page.url.searchParams.get('deleted')}<div class="adm-alert ok" role="status">Record deleted.</div>{/if}
<div class="adm-alert info"><span aria-hidden="true">ℹ</span> Connection state below is what the app last <strong>persisted</strong> (status, timestamps, last error). It is not a live health check; a stored token or ID does not prove the connection works.</div>

<div class="adm-card">
	<div class="toolbar">
		<input type="search" class="adm-input search" placeholder="Search stores by name, store ID, seller ID, Salesforce ID or marketplace…" aria-label="Search stores" bind:value={search} />
		{#if search}<button type="button" class="adm-btn outline sm" on:click={() => (search = '')}>Clear</button>{/if}
	</div>
	<div class="pillbar">
		{#each FILTERS as [k, label]}
			<button type="button" class="pill" class:active={filter === k} on:click={() => (filter = k)}>{label} <span>{count(k)}</span></button>
		{/each}
		<span class="adm-muted foot">Showing {list.length} of {data.stores.length} stores</span>
	</div>
	{#if list.length === 0}
		<div class="adm-empty">{data.stores.length === 0 ? 'This account has no stores.' : 'No stores match these filters.'}</div>
	{:else}
		<div class="adm-table-wrap">
			<table class="adm-table">
				<caption class="adm-sr">Stores</caption>
				<thead><tr><th scope="col">Store</th><th scope="col">Marketplaces</th><th scope="col">Seller ID</th><th scope="col">Point of contact</th><th scope="col">Persisted SP-API</th><th scope="col">Salesforce store</th><th scope="col">Record</th></tr></thead>
				<tbody>
					{#each list as s (s.id)}
						{@const sp = SP[spKey(s)]}
						{@const sf = SF[s.sfState]}
						<tr>
							<td>
								<a href="{base}/records/store/{s.id}" title="Open store record">{s.name}</a><br />
								<span class="adm-mono adm-muted">{s.id}</span>
							</td>
							<td>
								{#each mps(s) as m}<span class="mp">{m}</span>{/each}
								<div class="adm-muted">{s.country ?? ''}</div>
							</td>
							<td class="adm-mono">{s.seller_id ?? '—'}</td>
							<td>{s.poc_name ?? '—'}<br /><span class="adm-muted">{s.poc_email ?? ''}</span></td>
							<td>
								<span class="chip" style="background:{sp[1]};color:{sp[2]}">{sp[0]}</span>
								<div class="adm-muted">{s.spapi_connected_at ? 'since ' + fmt(s.spapi_connected_at) : 'Not connected'}</div>
								{#if s.spapi_last_error}<div style="color:var(--red)">Last error: {s.spapi_last_error}</div>{/if}
							</td>
							<td>
								<span class="chip" style="background:{sf[1]};color:{sf[2]}" title={s.sfState === 'synced' ? 'This record exists in Salesforce.' : s.sfdc_store_id ? 'The stored link points to a record Salesforce no longer has.' : 'Never created in Salesforce.'}>{sf[0]}</span>
								{#if s.sfdc_store_id}<div class="adm-mono adm-muted">{s.sfdc_store_id}</div>{/if}
							</td>
							<td><RowMenu items={menu(s)} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

{#if modal}
	{@const m = modal}
	<RecordModal
		kind={m.kind === 'delete' ? 'delete' : 'sync'}
		title={m.kind === 'create' ? 'Create store in Salesforce' : m.kind === 'sync' ? 'Sync store to Salesforce' : 'Delete store record'}
		body={m.kind === 'create'
			? 'Creates this store in Salesforce and stores the new Salesforce ID. Use this when it was never created or creation failed. Logged with your reason.'
			: m.kind === 'sync'
				? 'Pushes the app’s current values for this store to its existing Salesforce record. Logged with your reason.'
				: 'Permanently deletes this store, its documents and uploaded files from the app. Its Salesforce record is not deleted. Requires recent MFA.'}
		recordName={m.store.name}
		recordId={m.store.id}
		action={m.kind === 'delete' ? '?/delete' : '?/resync'}
		hidden={m.kind === 'delete' ? { targetId: m.store.id } : { kind: 'store', targetId: m.store.id, mode: m.kind === 'create' ? 'create' : 'update' }}
		confirmText={m.store.name}
		submitLabel={m.kind === 'create' ? 'Create in Salesforce' : m.kind === 'sync' ? 'Push values' : 'Delete record'}
		on:close={() => (modal = null)}
	/>
{/if}

<style>
	.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
	.search { flex: 1; }
	.pillbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
	.pill { background: #fff; border: 1px solid var(--grey-line); border-radius: 99px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer; }
	.pill.active { background: var(--navy); border-color: var(--navy); color: #fff; }
	.pill span { opacity: .7; margin-left: 3px; }
	.foot { margin-left: auto; font-size: 12px; }
	.chip { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
	.mp { display: inline-block; background: #EEF2F8; border-radius: 6px; padding: 1px 7px; font-size: 11px; font-weight: 700; margin: 0 4px 3px 0; color: var(--navy); }
</style>
