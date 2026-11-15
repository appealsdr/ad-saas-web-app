<script lang="ts">
	import type { PageData } from './$types';
	export let data: PageData;
	const WHY: Record<string, string> = { email: 'Same email', website: 'Same website', name: 'Same company name' };
</script>

<svelte:head><title>Account merge — Admin</title></svelte:head>

<h1 class="adm-h1">Account merge</h1>
<p class="adm-sub">Find platform accounts that are probably the same customer. Merging is <strong>not enabled yet</strong>: this tab is read-only while the merge procedure is reviewed (see <span class="adm-mono">docs/account-merge-proposal.md</span>).</p>

<div class="adm-alert info" role="note">
	<strong>When this happens:</strong> the client was set up from Salesforce (account, stores, cases) and later registered on the platform themselves and bought a
	contract, so they now have two platform accounts and two Salesforce accounts. The proposal keeps the account with the history as the survivor,
	moves users, stores, contracts and payments into it, then re-parents the Salesforce records and retires the duplicate.
</div>

<div class="adm-card">
	{#if data.groups.length === 0}
		<div class="adm-empty">No likely duplicates found among {data.scanned} accounts.</div>
	{:else}
		<p class="adm-muted">{data.groups.length} possible duplicate group{data.groups.length === 1 ? '' : 's'} · {data.scanned} accounts scanned</p>
		{#each data.groups as g (g.signal + g.key)}
			<section class="grp">
				<h2><span class="sig">{WHY[g.signal]}</span> <span class="adm-mono">{g.key}</span></h2>
				<div class="adm-table-wrap">
					<table class="adm-table">
						<thead><tr><th>Account</th><th>Salesforce account</th><th>Users</th><th>Stores</th><th>Contracts</th><th>Created</th></tr></thead>
						<tbody>
							{#each g.accounts as a (a.id)}
								<tr>
									<td><a href="/admin/accounts/{a.id}">{a.name}</a></td>
									<td class="adm-mono">{a.sfdc ?? '—'}</td>
									<td>{a.users}</td><td>{a.stores}</td><td>{a.contracts}</td><td>{a.created}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/each}
	{/if}
</div>

<style>
	.grp { margin-top: 16px; }
	.grp h2 { font-size: 14px; margin: 0 0 6px; color: var(--navy); }
	.sig { background: #FEF3C7; color: #92400e; border-radius: 10px; padding: 2px 9px; font-size: 11px; font-weight: 700; margin-right: 6px; }
</style>
