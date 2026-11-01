<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	let busy = false;
	const d = (v: Date | string | null) => (v ? new Date(v).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—');
</script>

<svelte:head><title>Integrations — Admin</title></svelte:head>
<div class="adm-card">
	<h2>Linked records</h2>
	<p class="adm-muted">Source: local database, read {data.localAsOf}. A link existing here does <strong>not</strong> mean the integration is healthy.</p>
	<dl class="adm-kv">
		<dt>Salesforce account</dt><dd class="adm-mono">{data.links.sfdcAccountId ?? 'not linked'}</dd>
		<dt>Stripe customer</dt><dd class="adm-mono">{data.links.stripeCustomerId ?? 'not linked'}</dd>
	</dl>
	<h2 style="margin-top:16px">Stores</h2>
	{#if data.stores.length === 0}<p class="adm-null">No stores.</p>{:else}
		<table class="adm-table"><thead><tr><th scope="col">Store</th><th scope="col">Salesforce store</th><th scope="col">Persisted SP-API status</th><th scope="col">Last error</th></tr></thead>
			<tbody>{#each data.stores as s}<tr><td>{s.name}</td><td class="adm-mono">{s.sfdc ?? 'not linked'}</td><td>{s.status}{#if s.connectedAt} · since {d(s.connectedAt)}{/if}</td><td>{s.lastError ?? '—'}</td></tr>{/each}</tbody></table>
	{/if}
</div>

<div class="adm-card">
	<h2>Salesforce sync queue (local)</h2>
	{#if data.syncState.length === 0}<p class="adm-null">No queued records are linked to this account.</p>{:else}
		<table class="adm-table"><thead><tr><th scope="col">Object</th><th scope="col">Status</th><th scope="col">Count</th><th scope="col">Last queued</th></tr></thead>
			<tbody>{#each data.syncState as r}<tr><td>{r.sfdc_object}</td><td>{r.status}</td><td>{r.n}</td><td>{d(r.last_at)}</td></tr>{/each}</tbody></table>
	{/if}
	<h2 style="margin-top:16px">Recent integration errors</h2>
	{#if data.syncErrors.length === 0}<p class="adm-null">None recorded for this account.</p>{:else}
		<table class="adm-table"><tbody>{#each data.syncErrors as e}<tr><td class="adm-mono">{d(e.at)}</td><td>{e.source} / {e.operation}</td><td>{e.message}</td></tr>{/each}</tbody></table>
	{/if}
</div>

<div class="adm-card">
	<h2>Live Salesforce account</h2>
	{#if data.links.sfdcAccountId}
		<form method="POST" action="?/salesforce" use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update({ reset: false }); }; }}>
			<button class="adm-btn" type="submit" disabled={busy}>{busy ? 'Contacting Salesforce…' : 'Fetch from Salesforce'}</button>
		</form>
	{:else}<p class="adm-null">Not linked.</p>{/if}
	{#if form && 'sf' in form && form.sf}
		{@const s = form.sf}
		<p class="adm-muted">Source: {s.source} · fetched {s.fetchedAt}</p>
		{#if s.ok}<pre class="adm-pre">{JSON.stringify(s.data, null, 2)}</pre>{:else}<div class="adm-alert error">Salesforce unavailable: {s.error}. Local data above is unaffected.</div>{/if}
	{/if}
</div>
