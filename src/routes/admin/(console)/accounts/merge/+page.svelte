<script lang="ts">
	import type { PageData } from './$types';
	export let data: PageData;
	const WHY: Record<string, string> = { email: 'Same email', website: 'Same website', name: 'Same company name' };
	type Row = PageData['groups'][number]['accounts'][number];
	// Suggest keeping the account with the most history (stores + contracts), then the oldest; merge the next one into it.
	const ranked = (rows: Row[]) => [...rows].sort((a, b) => b.stores + b.contracts - (a.stores + a.contracts) || a.created.localeCompare(b.created));
	const suggestedKeep = (rows: Row[]) => ranked(rows)[0].id;
	const suggestedFrom = (rows: Row[]) => ranked(rows)[1].id;
</script>

<svelte:head><title>Account merge — Admin</title></svelte:head>

<h1 class="adm-h1">Account merge</h1>
<p class="adm-sub">Find platform accounts that are probably the same customer, then merge two of them: choose the account that stays, review what moves, and confirm. Procedure: <span class="adm-mono">docs/account-merge-proposal.md</span>.</p>

<div class="adm-alert info" role="note">
	<strong>When this happens:</strong> the client was set up from Salesforce (account, stores, cases) and later registered on the platform themselves and bought a
	contract, so they now have two platform accounts and two Salesforce accounts. The proposal keeps the account with the history as the survivor,
	moves users, stores, contracts and payments into it, then re-parents the Salesforce records and retires the duplicate.
</div>

<form method="GET" action="/admin/accounts/merge/review" class="adm-card" aria-label="Merge two accounts by ID">
	<div class="adm-row">
		<label class="grow">Account that stays (ID)<input name="keep" required pattern="[0-9a-fA-F-]{'{'}36{'}'}" placeholder="Local account ID" /></label>
		<label class="grow">Account to merge into it (ID)<input name="from" required pattern="[0-9a-fA-F-]{'{'}36{'}'}" placeholder="Local account ID" /></label>
		<button class="adm-btn" type="submit">Review merge</button>
	</div>
	<p class="adm-muted" style="margin:0">Or pick the two accounts from a group below. Copy an ID from the account's page.</p>
</form>

<div class="adm-card">
	{#if data.groups.length === 0}
		<div class="adm-empty">No likely duplicates found among {data.scanned} accounts.</div>
	{:else}
		<p class="adm-muted">{data.groups.length} possible duplicate group{data.groups.length === 1 ? '' : 's'} · {data.scanned} accounts scanned</p>
		{#each data.groups as g (g.signal + g.key)}
			<section class="grp">
				<h2><span class="sig">{WHY[g.signal]}</span> <span class="adm-mono">{g.key}</span></h2>
				<form method="GET" action="/admin/accounts/merge/review">
					<div class="adm-table-wrap">
						<table class="adm-table">
							<thead><tr><th>Stays</th><th>Merge into it</th><th>Account</th><th>Salesforce account</th><th>Users</th><th>Stores</th><th>Contracts</th><th>Created</th></tr></thead>
							<tbody>
								{#each g.accounts as a, i (a.id)}
									<tr>
										<td><input type="radio" name="keep" value={a.id} checked={a.id === suggestedKeep(g.accounts)} required aria-label="Keep {a.name}" /></td>
										<td><input type="radio" name="from" value={a.id} checked={a.id === suggestedFrom(g.accounts)} required aria-label="Merge {a.name}" /></td>
										<td><a href="/admin/accounts/{a.id}">{a.name}</a></td>
										<td class="adm-mono">{a.sfdc ?? '—'}</td>
										<td>{a.users}</td><td>{a.stores}</td><td>{a.contracts}</td><td>{a.created}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="grp-actions"><button class="adm-btn sm" type="submit">Review merge…</button></div>
				</form>
			</section>
		{/each}
	{/if}
</div>

<style>
	.grp { margin-top: 16px; }
	.grp-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
	.grow { flex: 1; min-width: 240px; }
	.grp h2 { font-size: 14px; margin: 0 0 6px; color: var(--navy); }
	.sig { background: #FEF3C7; color: #92400e; border-radius: 10px; padding: 2px 9px; font-size: 11px; font-weight: 700; margin-right: 6px; }
</style>
