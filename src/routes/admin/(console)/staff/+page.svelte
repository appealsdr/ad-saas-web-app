<script lang="ts">
	import { enhance } from '$app/forms';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;

	type Member = PageData['staff'][number];
	type Tab = 'role' | 'password' | 'mfa' | 'deactivate';

	let modal: { kind: 'create' } | { kind: 'manage'; s: Member } | null = null;
	let tab: Tab = 'role';
	let busy = false;
	$: modalOpen = modal !== null;
	$: isSelf = modal?.kind === 'manage' && modal.s.user_id === data.me;
	$: tabs = ([['role', 'Role'], ['password', 'Password'], ['mfa', 'MFA'], ['deactivate', 'Deactivate']] as [Tab, string][]).filter(([t]) => !isSelf || t === 'mfa' || t === 'deactivate');

	function manage(s: Member) {
		modal = { kind: 'manage', s };
		tab = s.user_id === data.me ? 'mfa' : 'role';
	}
	const close = () => (modal = null);

	// Close the dialog only when the action succeeded; on a validation error keep it open and show the message inside.
	const submit: SubmitFunction = () => {
		busy = true;
		return async ({ result, update }) => {
			await update({ reset: result.type === 'success' });
			busy = false;
			if (result.type === 'success') close();
		};
	};
</script>

<svelte:head><title>Staff — Admin</title></svelte:head>
<svelte:window on:keydown={(e) => e.key === 'Escape' && modalOpen && close()} />

<div class="head">
	<div>
		<h1 class="adm-h1">Platform staff</h1>
		<p class="adm-sub">Staff membership is separate from customer roles. Changes require MFA verified in the last 5 minutes.</p>
	</div>
	<button type="button" class="adm-btn" on:click={() => (modal = { kind: 'create' })}>+ Create admin</button>
</div>

{#if !data.fresh}<div class="adm-alert warn">Your MFA check is stale. <a href="/admin/reauth?next=/admin/staff">Re-verify</a> before making changes.</div>{/if}
{#if form && 'ok' in form && form.ok}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'tempPassword' in form && form.tempPassword}
	<div class="adm-alert warn" role="status">Temporary password for <strong>{form.tempFor}</strong> — shown <strong>once</strong>, copy it now and share it securely: <code class="adm-mono">{form.tempPassword}</code></div>
{/if}
{#if form && 'error' in form && form.error && !modalOpen}<div class="adm-alert error" role="alert">{form.error}</div>{/if}

<div class="adm-card">
	<table class="adm-table">
		<caption class="adm-sr">Staff</caption>
		<thead><tr><th scope="col">Staff member</th><th scope="col">Role</th><th scope="col">State</th><th scope="col">Password</th><th scope="col">MFA</th><th scope="col">Manage</th></tr></thead>
		<tbody>
			{#each data.staff as s (s.user_id)}
				<tr>
					<td>{s.display_name ?? ''}<br /><span class="adm-muted">{s.email}</span></td>
					<td>{s.role}</td><td>{s.is_active ? 'Active' : 'Deactivated'}</td><td>{s.has_password ? 'Set' : 'Not set'}</td><td>{s.mfa_enrolled ? 'Enrolled' : 'Not enrolled'}</td>
					<td>{#if s.is_active}<button type="button" class="adm-btn outline sm" on:click={() => manage(s)}>Manage…</button>{/if}</td>
				</tr>
			{/each}
		</tbody>
	</table>
</div>

<p class="adm-muted">The operator CLI (<code>scripts/admin-cli.mjs</code>) still works for bootstrap and recovery.</p>

{#if modal}
	<div class="backdrop" role="presentation" on:click={close}>
		<div class="modal" role="dialog" aria-modal="true" aria-label={modal.kind === 'create' ? 'Create admin' : 'Manage admin'} tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
			<header>
				<h3>{modal.kind === 'create' ? 'Create a new admin' : 'Manage admin'}</h3>
				<button type="button" class="x" aria-label="Close" on:click={close}>✕</button>
			</header>

			{#if modal.kind === 'create'}
				<form method="POST" action="?/create_admin" use:enhance={submit}>
					<div class="body">
						<p class="lead">Admin accounts are separate from customer users — own password and MFA, and the email may match a customer's. They enrol MFA at first sign-in at /admin/login. Leave the password blank to generate a one-time temporary password.</p>
						{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}
						<div class="grid">
							<label>Email *<input class="adm-input" name="email" type="email" required /></label>
							<label>Full name<input class="adm-input" name="name" /></label>
							<label>Role *<select class="adm-input" name="role"><option value="platform_viewer">platform_viewer</option><option value="platform_admin">platform_admin</option></select></label>
							<label>Password (min 12, optional)<input class="adm-input" name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" /></label>
							<label class="full">Reason * (5–500 characters)<input class="adm-input" name="reason" required minlength="5" maxlength="500" /></label>
						</div>
					</div>
					<footer>
						<button type="button" class="adm-btn outline" on:click={close}>Cancel</button>
						<button type="submit" class="adm-btn" disabled={busy}>{busy ? 'Working…' : 'Create admin'}</button>
					</footer>
				</form>
			{:else}
				{@const s = modal.s}
				<div class="who"><strong>{s.display_name ?? s.email}</strong><span class="adm-muted">{s.email} · {s.role}</span></div>
				<nav class="tabs" role="tablist">
					{#each tabs as [t, label]}
						<button type="button" role="tab" aria-selected={tab === t} class:active={tab === t} on:click={() => (tab = t)}>{label}</button>
					{/each}
				</nav>
				{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert" style="margin:12px 18px 0">{form.error}</div>{/if}

				{#if tab === 'role' && !isSelf}
					<form method="POST" action="?/set_role" use:enhance={submit}>
						<div class="body">
							<p class="lead">Changes this admin's permissions and signs them out everywhere.</p>
							<input type="hidden" name="email" value={s.email} />
							<label>Role<select class="adm-input" name="role">
								<option value="platform_viewer" selected={s.role === 'platform_viewer'}>platform_viewer</option>
								<option value="platform_admin" selected={s.role === 'platform_admin'}>platform_admin</option>
							</select></label>
							<label>Reason * (5–500 characters)<input class="adm-input" name="reason" required minlength="5" maxlength="500" /></label>
						</div>
						<footer><button type="button" class="adm-btn outline" on:click={close}>Cancel</button><button type="submit" class="adm-btn" disabled={busy}>{busy ? 'Working…' : 'Change role'}</button></footer>
					</form>
				{:else if tab === 'password' && !isSelf}
					<form method="POST" action="?/set_password" use:enhance={submit}>
						<div class="body">
							<p class="lead">{s.has_password ? 'Resets' : 'Sets'} the password and signs this admin out everywhere. Leave blank to generate a one-time temporary password (shown once).</p>
							<input type="hidden" name="userId" value={s.user_id} />
							<input type="hidden" name="email" value={s.email} />
							<label>New password (min 12, optional)<input class="adm-input" name="password" type="password" minlength="12" maxlength="200" autocomplete="new-password" /></label>
							<label>Reason * (5–500 characters)<input class="adm-input" name="reason" required minlength="5" maxlength="500" /></label>
						</div>
						<footer><button type="button" class="adm-btn outline" on:click={close}>Cancel</button><button type="submit" class="adm-btn" disabled={busy}>{busy ? 'Working…' : s.has_password ? 'Reset password' : 'Set password'}</button></footer>
					</form>
				{:else if tab === 'mfa'}
					<form method="POST" action="?/reset_mfa" use:enhance={submit}>
						<div class="body">
							<p class="lead">Removes their MFA credential and recovery codes and signs them out. They must enrol again at next sign-in.</p>
							<input type="hidden" name="userId" value={s.user_id} />
							<label>Reason * (5–500 characters)<input class="adm-input" name="reason" required minlength="5" maxlength="500" /></label>
						</div>
						<footer><button type="button" class="adm-btn outline" on:click={close}>Cancel</button><button type="submit" class="adm-btn" disabled={busy}>{busy ? 'Working…' : 'Reset MFA'}</button></footer>
					</form>
				{:else if tab === 'deactivate'}
					<form method="POST" action="?/deactivate" use:enhance={submit}>
						<div class="body">
							<p class="lead">Deactivates this admin and signs them out. The last active platform admin cannot be deactivated.</p>
							<input type="hidden" name="userId" value={s.user_id} />
							<label>Reason * (5–500 characters)<input class="adm-input" name="reason" required minlength="5" maxlength="500" /></label>
						</div>
						<footer><button type="button" class="adm-btn outline" on:click={close}>Cancel</button><button type="submit" class="adm-btn danger" disabled={busy}>{busy ? 'Working…' : 'Deactivate'}</button></footer>
					</form>
				{/if}
			{/if}
		</div>
	</div>
{/if}

<style>
	.head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
	.backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.55); z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 24px; }
	.modal { background: #fff; border-radius: 12px; width: min(560px, 100%); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.25); }
	header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--grey-line); }
	h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy); }
	.x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); }
	form { display: flex; flex-direction: column; min-height: 0; }
	.body { padding: 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
	.lead { margin: 0; font-size: 13px; color: var(--navy); }
	.who { display: flex; flex-direction: column; background: #F6F8FB; padding: 10px 18px; }
	.tabs { display: flex; gap: 4px; padding: 0 18px; border-bottom: 1px solid var(--grey-line); }
	.tabs button { background: none; border: 0; border-bottom: 3px solid transparent; padding: 10px 12px; font: inherit; font-size: 13px; font-weight: 700; color: var(--navy); cursor: pointer; opacity: .65; }
	.tabs button.active { border-bottom-color: var(--navy); opacity: 1; }
	label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 700; color: var(--grey-text); }
	.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.grid .full { grid-column: 1 / -1; }
	footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--grey-line); }
</style>
