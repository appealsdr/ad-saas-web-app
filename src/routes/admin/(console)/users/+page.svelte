<script lang="ts">
	import type { PageData } from './$types';
	export let data: PageData;
	$: pages = Math.max(1, Math.ceil(data.total / data.pageSize));
	$: base = new URLSearchParams({ q: data.q, filter: data.filter, pageSize: String(data.pageSize) }).toString();
	const fmt = (d: Date | string | null) => (d ? new Date(d).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'never');
</script>

<svelte:head><title>Users — Admin</title></svelte:head>
<h1 class="adm-h1">All users</h1>
<p class="adm-sub">Every user regardless of account membership, including users with no account.</p>
<form method="GET" class="adm-card" role="search">
	<div class="adm-row">
		<label>Search (email, name, account, user ID)<input type="search" name="q" value={data.q} style="min-width:280px" /></label>
		<label>Show
			<select name="filter">
				<option value="" selected={data.filter === ''}>All users</option>
				<option value="no_account" selected={data.filter === 'no_account'}>No account</option>
				<option value="inactive" selected={data.filter === 'inactive'}>Suspended</option>
				<option value="locked" selected={data.filter === 'locked'}>Locked out</option>
			</select>
		</label>
		<button class="adm-btn" type="submit">Apply</button>
	</div>
</form>
<div class="adm-card">
	{#if data.rows.length === 0}<div class="adm-empty">No users match.</div>{:else}
		<div class="adm-table-wrap"><table class="adm-table">
			<caption class="adm-sr">Users</caption>
			<thead><tr><th scope="col">User</th><th scope="col">Account</th><th scope="col">Customer role</th><th scope="col">State</th><th scope="col">Last login</th></tr></thead>
			<tbody>
				{#each data.rows as u (u.id)}
					<tr>
						<td>{u.display_name ?? ''}<br /><span class="adm-muted">{u.email}</span>{#if u.is_staff} <span class="adm-muted">(platform staff)</span>{/if}<br /><span class="adm-mono adm-muted">{u.id}</span></td>
						<td>{#if u.account_id}<a href="/admin/accounts/{u.account_id}/users">{u.account_name}</a>{:else}<span class="adm-null">no account</span>{/if}</td>
						<td>{u.role}</td><td>{u.is_active ? 'Active' : 'Suspended'}</td><td>{fmt(u.last_login_at)}</td>
					</tr>
				{/each}
			</tbody></table></div>
		<nav class="adm-pager" aria-label="Pagination">
			<span>{data.total} user{data.total === 1 ? '' : 's'} · page {data.page} of {pages}</span>
			<span style="display:flex;gap:8px">
				{#if data.page > 1}<a class="adm-btn outline sm" href="/admin/users?{base}&page={data.page - 1}">← Previous</a>{/if}
				{#if data.page < pages}<a class="adm-btn outline sm" href="/admin/users?{base}&page={data.page + 1}">Next →</a>{/if}
			</span>
		</nav>
	{/if}
</div>
