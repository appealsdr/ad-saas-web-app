<script lang="ts">
	import { page } from '$app/stores';
	import type { PageData } from './$types';
	export let data: PageData;
	$: pages = Math.max(1, Math.ceil(data.total / data.pageSize));
	const href = (p: number) => `/admin/accounts?${data.baseQuery ? data.baseQuery + '&' : ''}page=${p}`;
	const fmt = (d: Date | string) => new Date(d).toISOString().slice(0, 10) + ' UTC';
	$: ctx = encodeURIComponent(data.context);
</script>

<svelte:head><title>Accounts — Admin</title></svelte:head>

<h1 class="adm-h1">All accounts</h1>
{#if $page.url.searchParams.get('deleted')}<div class="adm-alert ok" role="status">Account permanently deleted.</div>{/if}
<p class="adm-sub">Every customer account, including incomplete, unlinked and ownerless ones. Dates are UTC.</p>

<form method="GET" class="adm-card" role="search">
	<div class="adm-row">
		<label>Search (name, email, local ID, Salesforce ID)
			<input type="search" name="q" value={data.query.q} style="min-width:280px" />
		</label>
		<label>Onboarding
			<select name="onboarding">
				<option value="" selected={data.query.onboarding === ''}>Any</option>
				<option value="complete" selected={data.query.onboarding === 'complete'}>Complete</option>
				<option value="incomplete" selected={data.query.onboarding === 'incomplete'}>Incomplete</option>
			</select>
		</label>
		<label>Sort
			<select name="sort">
				{#each [['created', 'Created'], ['name', 'Name'], ['users', 'Users'], ['stores', 'Stores']] as [v, l]}
					<option value={v} selected={data.query.sort === v}>{l}</option>
				{/each}
			</select>
		</label>
		<label>Order
			<select name="dir">
				<option value="desc" selected={data.query.dir === 'desc'}>Descending</option>
				<option value="asc" selected={data.query.dir === 'asc'}>Ascending</option>
			</select>
		</label>
		<label>Per page
			<select name="pageSize">
				{#each [25, 50, 100] as n}<option value={n} selected={data.pageSize === n}>{n}</option>{/each}
			</select>
		</label>
		<button class="adm-btn" type="submit">Apply</button>
	</div>
</form>

<div class="adm-card">
	{#if data.rows.length === 0}
		<div class="adm-empty">No accounts match.</div>
	{:else}
		<div class="adm-table-wrap">
			<table class="adm-table">
				<caption class="adm-sr">Accounts</caption>
				<thead>
					<tr>
						<th scope="col">Name</th><th scope="col">Local ID</th><th scope="col">Owner / contact</th>
						<th scope="col">Users</th><th scope="col">Stores</th><th scope="col">Onboarding</th>
						<th scope="col">Salesforce account</th><th scope="col">Created</th><th scope="col"><span class="adm-sr">Actions</span></th>
					</tr>
				</thead>
				<tbody>
					{#each data.rows as a (a.id)}
						<tr>
							<td><a href="/admin/accounts/{a.id}?from={ctx}">{a.name}</a></td>
							<td class="adm-mono">{a.id}</td>
							<td>
								{#if a.owner_email}{a.owner_name ?? ''} <span class="adm-muted">{a.owner_email}</span>
								{:else if a.account_email}<span class="adm-muted">{a.account_email} (account email; no owner user)</span>
								{:else}<span class="adm-null">unknown — no owner or contact</span>{/if}
							</td>
							<td>{a.user_count}</td>
							<td>{a.store_count}</td>
							<td>{a.onboarding_completed ? 'Complete' : 'Incomplete'}</td>
							<td class="adm-mono">{a.sfdc_account_id ?? '—'}</td>
							<td>{fmt(a.created_at)}</td>
							<td><a class="adm-btn sm" href="/admin/accounts/{a.id}?from={ctx}">Open account</a></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
		<nav class="adm-pager" aria-label="Pagination">
			<span>{data.total} account{data.total === 1 ? '' : 's'} · page {data.page} of {pages}</span>
			<span style="display:flex;gap:8px">
				{#if data.page > 1}<a class="adm-btn outline sm" href={href(data.page - 1)}>← Previous</a>{/if}
				{#if data.page < pages}<a class="adm-btn outline sm" href={href(data.page + 1)}>Next →</a>{/if}
			</span>
		</nav>
	{/if}
</div>
