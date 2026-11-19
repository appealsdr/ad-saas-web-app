<script lang="ts">
	import { useAdminTime } from '$lib/admin/tz';
	import { page } from '$app/stores';
	import RowMenu from '$lib/components/admin/RowMenu.svelte';
	import RecordModal from '$lib/components/admin/RecordModal.svelte';
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	const { fmt: fmtT, fmtDate: fmtD0 } = useAdminTime();
	export let data: PageData;
	export let form: ActionData;

	type U = PageData['users'][number];
	$: fmt = (d: Date | string | null) => (d ? $fmtT(d) : 'never');
	const isLocked = (d: Date | string | null) => !!d && new Date(d) > new Date();
	const ROLE: Record<string, [string, string]> = { owner: ['#E0E7FF', '#3730A3'], admin: ['#DBEAFE', '#1d4ed8'], member: ['#F1F5F9', '#475569'] };
	const SF = { synced: ['Synced', '#DCFCE7', '#15803d'], not_in_sf: ['Not in Salesforce', '#FEE2E2', '#b91c1c'], unknown: ['Unknown', '#FEF3C7', '#92400e'] } as const;
	const FILTERS = [['all', 'All'], ['active', 'Active'], ['suspended', 'Suspended'], ['locked', 'Locked'], ['sf', 'Not in Salesforce']] as const;

	let filter: (typeof FILTERS)[number][0] = 'all';
	let search = '';
	type M = {
		kind: 'sync' | 'reason' | 'confirm'; user: U; title: string; body: string; action: string;
		hidden: Record<string, string>; submit: string; native?: boolean;
	};
	let modal: M | null = null;
	let showCreate = false;
	let createEmail = '';
	let createName = '';
	let createRole = 'member';
	let createMode: 'temp_password' | 'setup_link' = 'setup_link';
	let createReason = '';
	let creating = false;
	$: createOk = /\S+@\S+\.\S+/.test(createEmail) && createName.trim().length > 0 && createReason.trim().length >= 5;

	const matches = (u: U, f: string) =>
		f === 'all' || (f === 'active' ? u.is_active : f === 'suspended' ? !u.is_active : f === 'locked' ? isLocked(u.locked_until) : u.sfState !== 'synced');
	$: count = (f: string) => data.users.filter((u) => matches(u, f)).length;
	$: list = data.users.filter((u) => {
		const q = search.trim().toLowerCase();
		return matches(u, filter) && (!q || [u.email, u.display_name, u.id, u.role, u.sfdc_contact_id].join(' ').toLowerCase().includes(q));
	});
	$: rbase = `/admin/accounts/${$page.params.accountId}/records/user`;

	function menu(u: U) {
		const staff = u.is_staff;
		const can = data.canManage && !staff;
		const why = staff ? 'Managed under Staff' : data.canManage ? undefined : 'Your role is read-only';
		const act = (action: string, title: string, body: string, submit: string) => () =>
			(modal = { kind: 'confirm', user: u, title, body, action: '?/manage', hidden: { userId: u.id, action }, submit });
		return [
			{ label: 'View', icon: '👁', href: `${rbase}/${u.id}` },
			{ label: 'Edit', icon: '✏️', href: data.canSync ? `${rbase}/${u.id}?edit=1` : undefined, disabled: !data.canSync || staff, title: staff ? 'Managed under Staff' : undefined },
			{ label: 'View in Salesforce', icon: '↗', href: u.sfUrl ?? undefined, disabled: !u.sfUrl, title: u.sfUrl ? undefined : 'No linked Salesforce record' },
			{ label: 'Open read-only view', icon: '🔍', disabled: !can || !u.is_active, title: !u.is_active ? 'User is suspended' : why,
				run: () => (modal = { kind: 'reason', user: u, title: 'View as this user (read-only)', body: 'Opens their account exactly as they see it for 30 minutes, with every change blocked. Requires a recent MFA check and is logged with your reason.', action: '?/impersonate', hidden: { userId: u.id }, submit: 'Open read-only view', native: true }) },
			u.is_active
				? { label: 'Suspend user', icon: '⏸', danger: true, disabled: !can, title: why, run: act('suspend', 'Suspend user', 'Blocks sign-in and signs them out of every session.', 'Suspend') }
				: { label: 'Reactivate user', icon: '▶', disabled: !can, title: why, run: act('reactivate', 'Reactivate user', 'Lets this user sign in again.', 'Reactivate') },
			{ label: 'Unlock login', icon: '🔓', disabled: !can, title: why, run: act('unlock', 'Unlock login', 'Clears the lockout and failed-attempt counter.', 'Unlock') },
			{ label: 'Revoke sessions', icon: '🚪', disabled: !can, title: why, run: act('revoke_sessions', 'Revoke customer sessions', 'Signs this user out everywhere.', 'Revoke') },
			{ label: 'Reset password (temporary)', icon: '🔑', disabled: !can || !u.is_active, title: why,
				run: () => (modal = { kind: 'confirm', user: u, title: 'Reset password with a temporary password', body: 'Generates a one-time password, shown to you once, signs the user out everywhere, and forces a new password at next sign-in. They are emailed a notification (without the password).', action: '?/temp', hidden: { userId: u.id }, submit: 'Set password' }) },
			{ label: 'Reset password (email link)', icon: '✉️', disabled: !can || !u.is_active, title: why,
				run: () => (modal = { kind: 'confirm', user: u, title: 'Reset password by email link', body: 'Emails this user a link (valid 1 hour) to choose a new password. After they set it they get a confirmation email.', action: '?/reset', hidden: { userId: u.id }, submit: 'Send email' }) },
			{ label: 'Create in Salesforce', icon: '＋', disabled: !data.canSync || staff || u.sfState !== 'not_in_sf', title: staff ? 'Managed under Staff' : u.sfState === 'synced' ? 'Already in Salesforce — use Sync to update it' : u.sfState === 'unknown' ? 'Salesforce could not be reached' : undefined,
				run: () => (modal = { kind: 'sync', user: u, title: 'Create user in Salesforce', body: 'Creates this user’s Contact under the account’s Salesforce Account and stores the new ID. Use this when it was never created or creation failed. Logged with your reason.', action: '?/resync', hidden: { kind: 'user', targetId: u.id, mode: 'create' }, submit: 'Create in Salesforce' }) },
			{ label: 'Sync to Salesforce', icon: '🔄', disabled: !data.canSync || staff || u.sfState !== 'synced', title: staff ? 'Managed under Staff' : u.sfState === 'synced' ? undefined : 'Not in Salesforce yet — create it first',
				run: () => (modal = { kind: 'sync', user: u, title: 'Sync user to Salesforce', body: 'Pushes this user’s current details to their existing Salesforce Contact. Logged with your reason.', action: '?/resync', hidden: { kind: 'user', targetId: u.id, mode: 'update' }, submit: 'Push values' }) },
			{ label: 'Delete', icon: '🗑', danger: true, href: `${rbase}/${u.id}#delete` }
		];
	}
</script>

<svelte:head><title>Users — Admin</title></svelte:head>
{#if $page.url.searchParams.get('deleted')}<div class="adm-alert ok" role="status">Record deleted.</div>{/if}
{#if form && 'ok' in form && form.ok}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}
{#if form && 'tempPassword' in form && form.tempPassword}
	<div class="adm-alert warn" role="alert">
		One-time temporary password (shown only once — copy it now and share it securely):
		<strong class="adm-mono" style="user-select:all">{form.tempPassword}</strong>
	</div>
{/if}

<div class="adm-card">
	<div class="toolbar">
		<input type="search" class="adm-input search" placeholder="Search users by name, email, role, user ID or Salesforce ID…" aria-label="Search users" bind:value={search} />
		{#if search}<button type="button" class="adm-btn outline sm" on:click={() => (search = '')}>Clear</button>{/if}
		{#if data.canManage}
			<button type="button" class="adm-btn" on:click={() => { createEmail = ''; createName = ''; createRole = 'member'; createMode = 'setup_link'; createReason = ''; showCreate = true; }}>＋ Add user</button>
		{/if}
	</div>
	<div class="pillbar">
		{#each FILTERS as [k, label]}
			<button type="button" class="pill" class:active={filter === k} on:click={() => (filter = k)}>{label} <span>{count(k)}</span></button>
		{/each}
		<span class="adm-muted foot">Showing {list.length} of {data.users.length} users</span>
	</div>
	{#if list.length === 0}
		<div class="adm-empty">{data.users.length === 0 ? 'This account has no users.' : 'No users match these filters.'}</div>
	{:else}
		<div class="adm-table-wrap">
			<table class="adm-table">
				<caption class="adm-sr">Account users</caption>
				<thead><tr><th scope="col">User</th><th scope="col">Customer role</th><th scope="col">State</th><th scope="col">Last login</th><th scope="col">Salesforce contact</th><th scope="col">Record</th></tr></thead>
				<tbody>
					{#each list as u (u.id)}
						{@const r = ROLE[u.role] ?? ROLE.member}
						{@const sf = SF[u.sfState]}
						<tr>
							<td>
								<a href="{rbase}/{u.id}" title="Open user record">{u.display_name ?? u.email}</a><br />
								{#if u.display_name}<span class="adm-muted">{u.email}</span><br />{/if}
								<span class="adm-mono adm-muted">{u.id}</span>
							</td>
							<td>
								<span class="chip" style="background:{r[0]};color:{r[1]}">{u.role}</span>
								{#if u.is_staff}<div class="adm-muted">platform staff</div>{/if}
							</td>
							<td>
								<span class="chip" style="background:{u.is_active ? '#DCFCE7' : '#F1F5F9'};color:{u.is_active ? '#15803d' : '#475569'}">{u.is_active ? 'Active' : 'Suspended'}</span>
								{#if isLocked(u.locked_until)}<div style="color:var(--red)">Locked until {fmt(u.locked_until)}</div>{/if}
								{#if u.must_reset_password}<div class="adm-muted">Must reset password</div>{/if}
							</td>
							<td>{fmt(u.last_login_at)}</td>
							<td>
								<span class="chip" style="background:{sf[1]};color:{sf[2]}" title={u.sfState === 'synced' ? 'This record exists in Salesforce.' : u.sfdc_contact_id ? 'The stored link points to a record Salesforce no longer has.' : 'Never created in Salesforce.'}>{sf[0]}</span>
								{#if u.sfdc_contact_id}<div class="adm-mono adm-muted">{u.sfdc_contact_id}</div>{/if}
							</td>
							<td><RowMenu items={menu(u)} /></td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

{#if modal}
	<RecordModal kind={modal.kind} title={modal.title} body={modal.body} recordName={modal.user.display_name ?? modal.user.email}
		recordId={modal.user.email} action={modal.action} hidden={modal.hidden} confirmText={modal.user.email}
		submitLabel={modal.submit} native={modal.native ?? false} on:close={() => (modal = null)} />
{/if}

{#if showCreate}
	<div class="backdrop" role="presentation" on:click={() => (showCreate = false)}>
		<div class="modal" role="dialog" aria-modal="true" aria-label="Add user" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
			<header><h3>Add user</h3><button type="button" class="x" aria-label="Close" on:click={() => (showCreate = false)}>✕</button></header>
			<form method="POST" action="?/create" use:enhance={() => { creating = true; return async ({ update }) => { await update({ reset: false }); creating = false; showCreate = false; }; }}>
				<div class="body">
					<label>Email *
						<input class="adm-input" name="email" type="email" required maxlength="254" bind:value={createEmail} />
					</label>
					<label>Name *
						<input class="adm-input" name="displayName" type="text" required maxlength="200" bind:value={createName} />
					</label>
					<label>Customer role
						<select class="adm-input" name="role" bind:value={createRole}>
							<option value="member">Member</option>
							<option value="admin">Admin</option>
							<option value="owner">Owner</option>
						</select>
					</label>
					<fieldset class="modebox">
						<legend>How should they get access?</legend>
						<label class="radio"><input type="radio" name="mode" value="setup_link" bind:group={createMode} />
							<span><strong>Email a one-time setup link</strong> — they get a link (valid 7 days, single use) to choose their own password.</span>
						</label>
						<label class="radio"><input type="radio" name="mode" value="temp_password" bind:group={createMode} />
							<span><strong>Set a temporary password</strong> — shown to you once, to share with them yourself; they must change it at next sign-in.</span>
						</label>
					</fieldset>
					<label>Reason (required, 5–500 characters)
						<input class="adm-input" name="reason" required minlength="5" maxlength="500" bind:value={createReason} />
					</label>
				</div>
				<footer>
					<button type="button" class="adm-btn outline" on:click={() => (showCreate = false)}>Cancel</button>
					<button type="submit" class="adm-btn" disabled={!createOk || creating}>{creating ? 'Creating…' : 'Create user'}</button>
				</footer>
			</form>
		</div>
	</div>
{/if}

<style>
	.toolbar { display: flex; gap: 8px; margin-bottom: 12px; }
	.search { flex: 1; }
	.pillbar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-bottom: 12px; }
	.pill { background: #fff; border: 1px solid var(--grey-line); border-radius: 99px; padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer; }
	.pill.active { background: var(--navy); border-color: var(--navy); color: #fff; }
	.pill span { opacity: .7; margin-left: 3px; }
	.foot { margin-left: auto; font-size: 12px; }
	.chip { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }

	.backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.55); z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 24px; }
	.modal { background: #fff; border-radius: 12px; width: min(560px, 100%); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.25); }
	.modal header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--grey-line); }
	.modal h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy); }
	.modal .x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); }
	.modal form { display: flex; flex-direction: column; min-height: 0; }
	.modal .body { padding: 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
	.modal label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 700; color: var(--grey-text); }
	.modebox { border: 1px solid var(--grey-line); border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
	.modebox legend { font-size: 12px; font-weight: 700; color: var(--navy); padding: 0 2px; }
	.radio { flex-direction: row !important; align-items: flex-start; gap: 8px; font-weight: 400; font-size: 13px; color: var(--navy); }
	.radio input { margin-top: 3px; }
	.modal footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--grey-line); }
</style>
