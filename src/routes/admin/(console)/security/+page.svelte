<script lang="ts">
	import { enhance } from '$app/forms';
	import { useAdminTime } from '$lib/admin/tz';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	const { fmt: fmtT } = useAdminTime();
	$: fmt = (d: string) => $fmtT(d, { seconds: true });
</script>

<svelte:head><title>Security — Admin</title></svelte:head>

<h1 class="adm-h1">Security</h1>
{#if form && 'ok' in form && form.ok}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}

<div class="adm-card">
	<h2>AI assistant connector</h2>
	<p class="adm-muted">
		Status: <strong>{data.globalEnabled ? 'running' : 'STOPPED'}</strong> · enabled for {data.stats.accounts_enabled} account(s) · {data.stats.active_connections} active connection(s).
		Stopping blocks <code>/mcp</code> and new sign-ins for everyone immediately; accounts are also switched on/off individually on the account page.
	</p>
	{#if data.canManage}
		<div class="adm-row">
			<form method="POST" action="?/set_global" use:enhance>
				<input type="hidden" name="enabled" value={data.globalEnabled ? 'false' : 'true'} />
				<button class="adm-btn {data.globalEnabled ? 'outline danger-text' : ''}" type="submit">{data.globalEnabled ? 'Stop connector (kill switch)' : 'Re-enable connector'}</button>
			</form>
			<form method="POST" action="?/revoke_all" use:enhance onsubmit={(e) => { if (!confirm('Disconnect EVERY assistant on the platform?')) e.preventDefault(); }}>
				<button class="adm-btn outline danger-text" type="submit">Revoke all connections</button>
			</form>
		</div>
	{:else}<p class="adm-muted">Only platform admins can change this.</p>{/if}
</div>

<div class="adm-card">
	<h2>Alerts</h2>
	<div class="adm-table-wrap">
		<table class="adm-table">
			<thead><tr><th>When</th><th>Severity</th><th>Kind</th><th>Account</th><th>Message</th><th></th></tr></thead>
			<tbody>
				{#each data.alerts as a (a.id)}
					<tr class:done={!!a.acknowledged_at}>
						<td>{fmt(a.created_at)}</td>
						<td><span class="sev {a.severity}">{a.severity}</span></td>
						<td><code>{a.kind}</code></td>
						<td>{#if a.account_id}<a href="/admin/accounts/{a.account_id}">{a.account_name ?? a.account_id}</a>{:else}—{/if}</td>
						<td>{a.message}</td>
						<td>{#if a.acknowledged_at}<span class="adm-muted">ack {a.acknowledged_by}</span>{:else}
							<form method="POST" action="?/ack" use:enhance><input type="hidden" name="id" value={a.id} /><button class="adm-btn sm outline" type="submit">Acknowledge</button></form>{/if}</td>
					</tr>
				{:else}<tr><td colspan="6" class="adm-empty">No alerts.</td></tr>{/each}
			</tbody>
		</table>
	</div>
</div>

<style>
	.done { opacity: .5; } .sev { padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 700; background: #E5E7EB; }
	.sev.high { background: #FEE2E2; color: #991b1b; } .sev.medium { background: #FEF3C7; color: #92400e; }
</style>
