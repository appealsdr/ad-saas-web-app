<script lang="ts">
	import { COMMON_ERRORS, ENDPOINTS, ERROR_EXAMPLE, QUICKSTART, type Field } from '$lib/admin/api-docs';
	import { onMount, tick } from 'svelte';
	import type { PageData } from './$types';
	export let data: PageData;

	const MENU = [
		['how', 'How it works'], ['quickstart', 'Quick start'], ['conventions', 'Authentication, limits & errors'], ['perms', 'Permissions at a glance'],
		['Stores', 'Stores'], ['Cases', 'Cases'], ['Messages', 'Messages'], ['Files', 'Files']
	] as const;
	let current = 'how';
	async function sync() {
		const h = decodeURIComponent(location.hash.slice(1));
		if (!h) return;
		const ep = ENDPOINTS.find((e) => 'perm-' + e.permission.replace(/\./g, '-') === h);
		if (ep) {
			current = ep.group;
			await tick();
			document.getElementById(h)?.scrollIntoView({ block: 'start' });
		} else if (MENU.some(([k]) => k === h)) current = h;
	}
	onMount(sync);
	function pick(k: string) {
		current = k;
		history.replaceState(null, '', '#' + k);
		window.scrollTo({ top: 0 });
	}
	const GROUPS = ['Stores', 'Cases', 'Messages', 'Files'] as const;
	const GROUP_TEXT: Record<string, string> = {
		Stores: 'The seller stores that belong to the account.',
		Cases: 'Support cases / services we work on for a store.',
		Messages: 'The conversation on a case.',
		Files: 'Documents we need from the client, and uploading them.'
	};
	const METHOD: Record<string, string> = { GET: '#DBEAFE;#1d4ed8', POST: '#DCFCE7;#15803d', PATCH: '#FEF3C7;#92400e' };
	const mc = (m: string) => METHOD[m].split(';');
	const id = (p: string) => 'perm-' + p.replace(/\./g, '-');
</script>

<svelte:head><title>API integrations — Admin</title></svelte:head>
<h1 class="adm-h1">API integrations — overview</h1>
<p class="adm-sub">How a client or third-party application connects to us, what each permission allows, and exactly what to send and what comes back. Share this with the client’s developers.</p>

<svelte:window on:hashchange={sync} />
<div class="adm-split">
	<nav class="adm-side" aria-label="API documentation sections">
		{#each MENU as [k, label]}
			<a href="#{k}" aria-current={current === k ? 'page' : undefined} on:click|preventDefault={() => pick(k)}>{label}</a>
		{/each}
	</nav>
	<div class="doc">
{#if current === 'how'}<div class="adm-card" id="how">
	<h2>How it works</h2>
	<ul class="plain">
		<li><strong>One account, many integrations.</strong> Each integration (for example “Customer ERP” or “Reporting Tool”) has its <em>own</em> credentials, permissions, default user, IP allowlist and rate limit. Pausing or changing one never affects another.</li>
		<li><strong>The credential is the identity.</strong> The key you send identifies the integration, which fixes the account it can see and the actions it may perform. You never pass an account or integration id.</li>
		<li><strong>Permissions are explicit.</strong> Each endpoint needs one specific permission; none implies another (being able to <em>read</em> a store does not let you <em>list</em> stores).</li>
		<li><strong>Attribution.</strong> Anything the integration creates (stores, cases, messages, uploads) is recorded as done by the integration’s <em>default user</em>.</li>
		<li><strong>Setting one up (admin):</strong> Accounts → the account → Integrations → <em>Add API integration</em>. Choose a name, default user and permissions, create it, then copy the key — it is displayed once only. Hand the key and this page to the client.</li>
	</ul>
</div>

{/if}
{#if current === 'quickstart'}<div class="adm-card" id="quickstart">
	<h2>Quick start</h2>
	<p class="adm-muted">Base URL for this environment: <code class="adm-mono">{data.origin}</code></p>
	<pre class="adm-pre adm-mono">{QUICKSTART}</pre>
</div>

{/if}
{#if current === 'conventions'}<div class="adm-card" id="conventions">
	<h2>Authentication, limits &amp; errors</h2>
	<dl class="adm-kv">
		<dt>Authentication</dt><dd>Header <code class="adm-mono">Authorization: Bearer adi_…</code> on every request. Keep the key server-side; it is never retrievable again after creation (ask an admin to issue/rotate a new one).</dd>
		<dt>Format</dt><dd>JSON in and out (<code class="adm-mono">Content-Type: application/json</code>), except file uploads, which send the raw file. Timestamps are ISO-8601.</dd>
		<dt>Ids</dt><dd>Stores use UUIDs; cases, messages and required-file slots use Salesforce ids (15–18 alphanumeric characters).</dd>
		<dt>Paging</dt><dd><code class="adm-mono">?limit=</code> (1–100, default 50) and <code class="adm-mono">?offset=</code> on list endpoints.</dd>
		<dt>Rate limit</dt><dd>Per integration, per minute (set by the admin; default 60). When exceeded you get <code class="adm-mono">429</code> with a <code class="adm-mono">Retry-After</code> header (seconds).</dd>
		<dt>IP allowlist</dt><dd>If the admin set one, requests from other addresses get <code class="adm-mono">403 IP_NOT_ALLOWED</code>.</dd>
		<dt>Idempotency</dt><dd>Send <code class="adm-mono">Idempotency-Key</code> on create/upload calls. A retry with the same key and same request returns the first result (header <code class="adm-mono">idempotent-replayed: true</code>) instead of creating a duplicate. Keys are kept 24 hours and are separate for each integration.</dd>
		<dt>Request id</dt><dd>Every response carries <code class="adm-mono">x-request-id</code>; quote it to support.</dd>
		<dt>Key lifecycle</dt><dd>Credentials may expire, be revoked, or be rotated (old keys keep working for a grace period set by the admin). Paused integrations answer <code class="adm-mono">503</code> until resumed.</dd>
	</dl>
	<h3>Error shape</h3>
	<pre class="adm-pre adm-mono">{ERROR_EXAMPLE}</pre>
	<table class="adm-table"><thead><tr><th scope="col">HTTP</th><th scope="col">code</th><th scope="col">Meaning</th></tr></thead>
		<tbody>{#each COMMON_ERRORS as [s, c, m]}<tr><td>{s}</td><td class="adm-mono">{c}</td><td>{m}</td></tr>{/each}</tbody></table>
</div>

{/if}
{#if current === 'perms'}<div class="adm-card" id="perms">
	<h2>Permissions at a glance</h2>
	<p class="adm-muted">Tick these per integration. Each one unlocks exactly one endpoint.</p>
	<table class="adm-table"><thead><tr><th scope="col">Permission</th><th scope="col">What it means</th><th scope="col">What the client gets</th></tr></thead>
		<tbody>{#each ENDPOINTS as e}
			<tr><td class="adm-mono"><a href="#{id(e.permission)}">{e.permission}</a></td><td><strong>{e.title}</strong><br />{e.means}</td><td>{e.youGet}</td></tr>
		{/each}</tbody></table>
</div>

{/if}
{#each GROUPS as g}
	{#if current === g}<div class="adm-card" id="g-{g}">
		<h2>{g}</h2>
		<p class="adm-muted">{GROUP_TEXT[g]}</p>
		{#each ENDPOINTS.filter((e) => e.group === g) as e}
			{@const c = mc(e.method)}
			<details class="ep" id={id(e.permission)} open>
				<summary>
					<span class="m" style="background:{c[0]};color:{c[1]}">{e.method}</span>
					<code class="adm-mono">{e.path}</code>
					<span class="adm-muted">— {e.title}</span>
					<span class="perm adm-mono">needs {e.permission}</span>
				</summary>
				<p><strong>What it means:</strong> {e.means}</p>
				<p><strong>What you get:</strong> {e.youGet}</p>
				{#each [['Headers', e.headers], ['Query parameters', e.query], ['Request body (JSON)', e.body]] as [label, fields]}
					{#if fields && (fields as Field[]).length}
						<h4>{label}</h4>
						<table class="adm-table"><thead><tr><th scope="col">Name</th><th scope="col">Type</th><th scope="col">Required</th><th scope="col">Notes</th></tr></thead>
							<tbody>{#each fields as Field[] as f}<tr><td class="adm-mono">{f.name}</td><td class="adm-mono">{f.type}</td><td>{f.required ? 'yes' : 'no'}</td><td>{f.note}</td></tr>{/each}</tbody></table>
					{/if}
				{/each}
				{#if e.requestExample}<h4>Example request</h4><pre class="adm-pre adm-mono">{e.requestExample}</pre>{/if}
				<h4>Response — {e.status}</h4>
				<pre class="adm-pre adm-mono">{e.responseExample}</pre>
				{#if e.notes}<ul class="plain">{#each e.notes as n}<li>{n}</li>{/each}</ul>{/if}
				<h4>Specific errors</h4>
				<ul class="plain">{#each e.errors as [s, m]}<li><span class="adm-mono">{s}</span> — {m}</li>{/each}</ul>
				<p class="adm-muted" style="font-size:12px">Plus the common errors above (401/403/429/503).</p>
			</details>
		{/each}
	</div>{/if}
{/each}
	</div>
</div>

<style>
	.doc { min-width: 0; }
	.adm-side { position: sticky; top: 12px; }
	.plain { margin: 6px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.6; }
	h3 { font-size: 14px; margin: 16px 0 8px; }
	h4 { font-size: 12px; text-transform: uppercase; letter-spacing: .4px; color: var(--grey-text); margin: 14px 0 6px; }
	.ep { border: 1px solid var(--grey-line); border-radius: 10px; padding: 10px 14px; margin: 12px 0; font-size: 13px; }
	.ep summary { cursor: pointer; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
	.m { font-size: 11px; font-weight: 800; padding: 2px 8px; border-radius: 6px; }
	.perm { margin-left: auto; font-size: 11px; background: var(--grey-bg); padding: 2px 8px; border-radius: 6px; }
	.ep p { margin: 8px 0; line-height: 1.5; }
	code { font-size: 12px; }
</style>
