<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
</script>

<svelte:head><title>Staff — Admin</title></svelte:head>
<h1 class="adm-h1">Platform staff</h1>
<p class="adm-sub">Staff membership is separate from customer roles. Changes require MFA verified in the last 5 minutes.</p>
{#if !data.fresh}<div class="adm-alert warn">Your MFA check is stale. <a href="/admin/reauth?next=/admin/staff">Re-verify</a> before making changes.</div>{/if}
{#if form && 'ok' in form && form.ok}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}

<div class="adm-card">
	<table class="adm-table">
		<caption class="adm-sr">Staff</caption>
		<thead><tr><th scope="col">Staff member</th><th scope="col">Role</th><th scope="col">State</th><th scope="col">MFA</th><th scope="col">Manage</th></tr></thead>
		<tbody>
			{#each data.staff as s (s.user_id)}
				<tr>
					<td>{s.display_name ?? ''}<br /><span class="adm-muted">{s.email}</span></td>
					<td>{s.role}</td><td>{s.is_active ? 'Active' : 'Deactivated'}</td><td>{s.mfa_enrolled ? 'Enrolled' : 'Not enrolled'}</td>
					<td>
						{#if s.is_active}
							<details><summary>Actions…</summary>
								<form method="POST" action="?/deactivate" use:enhance style="margin-top:8px">
									<input type="hidden" name="userId" value={s.user_id} />
									<label class="adm-muted" for="d-{s.user_id}">Reason</label>
									<input id="d-{s.user_id}" name="reason" class="adm-input" required minlength="5" />
									<button class="adm-btn danger sm" type="submit">Deactivate</button>
								</form>
								<form method="POST" action="?/reset_mfa" use:enhance style="margin-top:8px">
									<input type="hidden" name="userId" value={s.user_id} />
									<label class="adm-muted" for="m-{s.user_id}">Reason</label>
									<input id="m-{s.user_id}" name="reason" class="adm-input" required minlength="5" />
									<button class="adm-btn outline sm" type="submit">Reset MFA</button>
								</form>
							</details>
						{/if}
					</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<div class="adm-card">
	<h2>Change role</h2>
	<p class="adm-muted">Applies to an existing platform admin (exact email). Role changes sign them out everywhere.</p>
	<form method="POST" action="?/grant" use:enhance>
		<div class="adm-row">
			<label>Email<input name="email" type="email" required /></label>
			<label>Role<select name="role"><option value="platform_viewer">platform_viewer</option><option value="platform_admin">platform_admin</option></select></label>
			<label>Reason<input name="reason" required minlength="5" /></label>
			<button class="adm-btn" type="submit">Save</button>
		</div>
	</form>
</div>

<div class="adm-card">
	<h2>Create a new admin</h2>
	<p class="adm-muted">Admin accounts are separate from customer users — they have their own password and MFA, and may use the same email as a customer. They are created from the operator console only, so no web request can mint one:</p>
	<pre class="adm-pre">node --env-file=.env scripts/admin-cli.mjs create --email name@company.com --name "Full Name" --role platform_admin</pre>
	<p class="adm-muted">You will be asked for the initial password (min 12 characters). They enrol MFA at first sign-in.</p>
</div>
