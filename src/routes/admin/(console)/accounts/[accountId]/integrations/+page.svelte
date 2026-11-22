<script lang="ts">
	import { useAdminTime } from '$lib/admin/tz';
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import type { ActionData, PageData } from './$types';
	const { fmt: fmtT, fmtDate: fmtD0 } = useAdminTime();
	export let data: PageData;
	export let form: ActionData;
	let busy = false;
	$: d = (v: Date | string | null) => (v ? $fmtT(v) : '—');
	$: base = `/admin/accounts/${$page.params.accountId}/integrations`;
	const STATUS: Record<string, [string, string]> = { active: ['#DCFCE7', '#15803d'], paused: ['#FEF3C7', '#92400e'], disabled: ['#FEE2E2', '#b91c1c'] };
	let confirmPauseAll = '';
	const apiMsg = (f: unknown) => (f && typeof f === 'object' ? (f as { apiOk?: string; apiError?: string }) : {});
	$: m = apiMsg(form);
</script>

<svelte:head><title>Integrations — Admin</title></svelte:head>
<div class="adm-card">
	<div class="adm-row" style="justify-content:space-between;align-items:center">
		<h2 style="margin:0">API integrations</h2>
		{#if data.canManage}<a class="adm-btn" href="{base}/api/new">Add API integration</a>{/if}
	</div>
	<p class="adm-muted">Each integration has its own credentials, permission profile, default user, status, IP allowlist and rate limit. Pausing or rotating one never affects another. Secrets are never shown here.</p>
	{#if m.apiOk}<div class="adm-alert">{m.apiOk}</div>{/if}
	{#if m.apiError}<div class="adm-alert error">{m.apiError}</div>{/if}
	{#if data.apiIntegrations.length === 0}<p class="adm-null">No API integrations yet.</p>{:else}
		<table class="adm-table"><thead><tr><th scope="col">Integration</th><th scope="col">Default user</th><th scope="col">Permissions</th><th scope="col">Status</th><th scope="col">Last used</th><th scope="col">Actions</th></tr></thead>
			<tbody>{#each data.apiIntegrations as i}
				<tr>
					<td><a href="{base}/api/{i.id}">{i.name}</a></td>
					<td>{i.defaultUser ?? '—'}</td>
					<td>{i.permissionCount} of {i.permissionTotal}</td>
					<td><span style="background:{STATUS[i.status][0]};color:{STATUS[i.status][1]};padding:2px 8px;border-radius:99px;font-size:12px">{i.status}</span></td>
					<td>{d(i.lastUsedAt)}</td>
					<td>
						<a href="{base}/api/{i.id}">Edit</a>
						{#if data.canManage}
							{#if i.status === 'active'}
								<details style="display:inline-block;margin-left:8px"><summary style="cursor:pointer;display:inline">Pause</summary>
									<form method="POST" action="?/status" use:enhance class="adm-row" style="margin-top:6px">
										<input type="hidden" name="integrationId" value={i.id} /><input type="hidden" name="action" value="pause" />
										<input name="reason" placeholder="Reason (min 5 chars)" required minlength="5" />
										<button class="adm-btn" type="submit">Pause {i.name}</button>
									</form>
								</details>
							{:else}
								<form method="POST" action="?/status" use:enhance style="display:inline;margin-left:8px">
									<input type="hidden" name="integrationId" value={i.id} /><input type="hidden" name="action" value="resume" />
									<button class="adm-btn" type="submit">Resume</button>
								</form>
							{/if}
						{/if}
					</td>
				</tr>{/each}</tbody></table>
	{/if}

	{#if data.canManage && data.apiIntegrations.some((i) => i.status === 'active')}
		<details style="margin-top:12px"><summary style="cursor:pointer">Emergency stop: pause all API integrations on this account</summary>
			<form method="POST" action="?/pauseAll" use:enhance class="adm-row" style="margin-top:8px">
				<input name="reason" placeholder="Reason (min 5 chars)" required minlength="5" />
				<input name="confirm" bind:value={confirmPauseAll} placeholder="Type PAUSE ALL" autocomplete="off" required />
				<button class="adm-btn" type="submit" disabled={confirmPauseAll.trim() !== 'PAUSE ALL'}>Pause all integrations</button>
			</form>
		</details>
	{/if}

	<h3 style="margin-top:16px">API activity &amp; configuration changes</h3>
	<form method="GET" class="adm-row">
		<label>Integration
			<select name="integration" value={data.filter ?? ''} on:change={(e) => e.currentTarget.form?.submit()}>
				<option value="">All integrations</option>
				{#each data.apiIntegrations as i}<option value={i.id} selected={data.filter === i.id}>{i.name}</option>{/each}
			</select>
		</label>
		<noscript><button class="adm-btn" type="submit">Filter</button></noscript>
	</form>
	{#if data.configEvents.length}
		<table class="adm-table"><thead><tr><th scope="col">When</th><th scope="col">Admin</th><th scope="col">Change</th><th scope="col">Detail</th></tr></thead>
			<tbody>{#each data.configEvents as e}<tr><td class="adm-mono">{d(e.created_at)}</td><td>{e.actor_ref}</td><td>{e.action}</td><td class="adm-mono">{e.reason ?? ''} {e.metadata ? JSON.stringify(e.metadata) : ''}</td></tr>{/each}</tbody></table>
	{/if}
	{#if data.activity.length === 0}<p class="adm-null">No API requests recorded{data.filter ? ' for this integration' : ''}.</p>{:else}
		<table class="adm-table"><thead><tr><th scope="col">When</th><th scope="col">Integration</th><th scope="col">Operation</th><th scope="col">Permission</th><th scope="col">Outcome</th><th scope="col">Resource</th><th scope="col">IP</th><th scope="col">ms</th></tr></thead>
			<tbody>{#each data.activity as a}<tr><td class="adm-mono">{d(a.occurred_at)}</td><td>{a.integration_name ?? '—'}</td><td>{a.operation}</td><td class="adm-mono">{a.required_permission ?? ''}</td><td>{a.outcome}{a.http_status ? ` (${a.http_status}${a.error_code ? ' ' + a.error_code : ''})` : ''}</td><td class="adm-mono">{a.resource_type ?? ''} {a.resource_id ?? ''}</td><td class="adm-mono">{a.source_ip ?? ''}</td><td>{a.duration_ms ?? ''}</td></tr>{/each}</tbody></table>
	{/if}
</div>

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
