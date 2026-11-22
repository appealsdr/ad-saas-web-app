<script lang="ts">
	import { useAdminTime } from '$lib/admin/tz';
	import { page } from '$app/stores';
	import { enhance } from '$app/forms';
	import IntegrationForm from '$lib/components/admin/IntegrationForm.svelte';
	import type { ActionData, PageData } from './$types';
	const { fmt: fmtT } = useAdminTime();
	export let data: PageData;
	export let form: ActionData;
	$: d = (v: Date | string | null) => (v ? $fmtT(v) : '—');
	$: base = `/admin/accounts/${$page.params.accountId}/integrations`;
	$: f = (form ?? {}) as { ok?: string; error?: string; newKey?: string; retired?: number; rotated?: boolean };
	$: i = data.integration;
	$: values = {
		name: i.name, defaultUserId: i.defaultUserId, permissions: [...i.permissions], allowedIps: i.allowedIps,
		rateLimitPerMinute: i.rateLimitPerMinute, credentialTtlDays: (i.credentialTtlDays ?? '') as number | '', rotationGraceHours: i.rotationGraceHours
	};
	const credState = (c: { revoked_at: Date | null; expires_at: Date | null }) =>
		c.revoked_at ? 'revoked' : c.expires_at && new Date(c.expires_at) <= new Date() ? 'expired' : 'active';
</script>

<svelte:head><title>{i.name} — API integration — Admin</title></svelte:head>
<p><a href={base}>← Integrations</a></p>
<h1 class="adm-h1">{i.name} <small class="adm-muted">· {i.status}</small></h1>
{#if f.ok}<div class="adm-alert">{f.ok}</div>{/if}
{#if f.error}<div class="adm-alert error">{f.error}</div>{/if}

<div class="adm-card">
	<h2>Credentials</h2>
	<p class="adm-muted">Credentials belong to this integration only and inherit its permission profile. Last used: {d(i.lastUsedAt)}.</p>
	{#if f.newKey}
		<div class="adm-alert">New credential{f.rotated ? ` — ${f.retired} previous credential(s) retired per this integration's grace period` : ''}. Copy it now; it is shown once.</div>
		<pre class="adm-pre adm-mono" data-testid="raw-key">{f.newKey}</pre>
	{/if}
	<table class="adm-table"><thead><tr><th scope="col">Prefix</th><th scope="col">Label</th><th scope="col">State</th><th scope="col">Expires</th><th scope="col">Last used</th><th scope="col">IP</th><th scope="col"></th></tr></thead>
		<tbody>{#each data.credentials as c}
			<tr><td class="adm-mono">{c.key_prefix}…</td><td>{c.label ?? ''}</td><td>{credState(c)}{c.revoke_reason ? ` — ${c.revoke_reason}` : ''}</td><td>{d(c.expires_at)}</td><td>{d(c.last_used_at)}</td><td class="adm-mono">{c.last_used_ip ?? ''}</td>
				<td>{#if data.canManage && credState(c) === 'active'}
					<details><summary style="cursor:pointer">Revoke</summary>
						<form method="POST" action="?/revoke" use:enhance class="adm-row">
							<input type="hidden" name="credentialId" value={c.id} />
							<input name="reason" placeholder="Reason (min 5 chars)" required minlength="5" />
							<button class="adm-btn" type="submit">Revoke this credential</button>
						</form></details>{/if}</td></tr>
		{/each}</tbody></table>
	{#if data.canManage && i.status !== 'disabled'}
		<form method="POST" action="?/issue" use:enhance={() => async ({ update }) => update({ reset: false })} class="adm-row" style="margin-top:10px">
			<input name="label" placeholder="Label (optional)" maxlength="100" />
			<button class="adm-btn" type="submit" name="mode" value="issue">Issue additional credential</button>
			<button class="adm-btn" type="submit" name="mode" value="rotate">Rotate credentials</button>
		</form>
		<p class="adm-muted">Rotate issues a new credential and retires this integration's others after {i.rotationGraceHours}h (0 = immediately). Other integrations are not affected.</p>
	{/if}
</div>

{#if data.canManage}
	<div class="adm-card">
		<h2>Status</h2>
		{#if i.status === 'active'}
			<form method="POST" action="?/status" use:enhance class="adm-row">
				<input name="reason" placeholder="Reason (min 5 chars)" required minlength="5" />
				<button class="adm-btn" type="submit" name="action" value="pause">Pause this integration</button>
				<button class="adm-btn" type="submit" name="action" value="disable">Disable this integration</button>
			</form>
		{:else}
			<p>{i.status === 'paused' ? `Paused ${d(i.pausedAt)}: ${i.pauseReason ?? ''}` : `Disabled ${d(i.disabledAt)}: ${i.disableReason ?? ''}`}</p>
			<form method="POST" action="?/status" use:enhance>
				<button class="adm-btn" type="submit" name="action" value="resume">Resume</button>
			</form>
		{/if}
	</div>
{/if}

{#if data.canManage}
	<IntegrationForm action="?/save" submitLabel="Save changes" users={data.users} permissionOptions={data.permissionOptions} {values} />
{/if}

<div class="adm-card">
	<h2>Audit activity — {i.name}</h2>
	{#if data.configEvents.length}
		<table class="adm-table"><tbody>{#each data.configEvents as e}<tr><td class="adm-mono">{d(e.created_at)}</td><td>{e.actor_ref}</td><td>{e.action}</td><td class="adm-mono">{e.reason ?? ''} {e.metadata ? JSON.stringify(e.metadata) : ''}</td></tr>{/each}</tbody></table>
	{/if}
	{#if data.activity.length === 0}<p class="adm-null">No API requests recorded.</p>{:else}
		<table class="adm-table"><thead><tr><th scope="col">When</th><th scope="col">Operation</th><th scope="col">Permission</th><th scope="col">Outcome</th><th scope="col">Resource</th><th scope="col">IP</th><th scope="col">ms</th></tr></thead>
			<tbody>{#each data.activity as a}<tr><td class="adm-mono">{d(a.occurred_at)}</td><td>{a.operation}</td><td class="adm-mono">{a.required_permission ?? ''}</td><td>{a.outcome}{a.http_status ? ` (${a.http_status}${a.error_code ? ' ' + a.error_code : ''})` : ''}</td><td class="adm-mono">{a.resource_type ?? ''} {a.resource_id ?? ''}</td><td class="adm-mono">{a.source_ip ?? ''}</td><td>{a.duration_ms ?? ''}</td></tr>{/each}</tbody></table>
	{/if}
</div>
