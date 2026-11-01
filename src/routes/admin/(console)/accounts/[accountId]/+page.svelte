<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import RecordModal from '$lib/components/admin/RecordModal.svelte';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;

	const fmt = (d: Date | string | null) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—');
	$: a = data.account;
	const get = (k: string) => ((a as unknown as Record<string, string | null>)[k] ?? '');
	async function copy(t: string) { try { await navigator.clipboard.writeText(t); } catch { /* needs user gesture */ } }

	const SF_BANNER = {
		synced: ['Synced', 'This record exists in Salesforce.', '#ECFDF5', '#86efac', '#166534'],
		not_in_sf: ['Not in Salesforce', 'This account is not (or no longer) in Salesforce.', '#FEF2F2', '#fca5a5', '#b91c1c'],
		unknown: ['Unknown', 'Salesforce could not be reached, so the sync state is unknown.', '#FFFBEB', '#fcd34d', '#92400e']
	} as const;
	$: bn = SF_BANNER[data.sfState];

	const OWN = { sf: ['Salesforce', '#DBEAFE', '#1d4ed8'], local: ['Local only', '#F1F5F9', '#475569'], sys: ['Derived', '#FEF3C7', '#92400e'] } as const;
	const EDIT_FIELDS: [string, string][] = [
		['name', 'Company'], ['email', 'Account email'], ['phone', 'Phone'], ['website', 'Website'],
		['billing_street', 'Street'], ['billing_city', 'City'], ['billing_state', 'State'], ['billing_postal_code', 'Postal code'], ['billing_country', 'Country']
	];
	const GROUPS: { title: string; keys: string[] }[] = [
		{ title: 'Company & contact', keys: ['name', 'email', 'phone', 'website'] },
		{ title: 'Billing address', keys: ['billing_street', 'billing_city', 'billing_state', 'billing_postal_code', 'billing_country'] }
	];
	const label = (k: string) => EDIT_FIELDS.find(([x]) => x === k)![1];

	type Row = { label: string; key?: string; value: string; own: 'sf' | 'local' | 'sys'; api?: string; note?: string; mono?: boolean };
	$: groups = [
		...GROUPS.map((g) => ({
			title: g.title,
			rows: g.keys.map((k): Row => ({ label: label(k), key: k, value: get(k) || '—', own: 'sf', api: `Account.${data.sfFields[k]}` }))
		})),
		{
			title: 'Usage',
			rows: [
				{ label: 'Owner', value: data.summary.owner_email ?? 'unknown — no owner user', own: 'sys', note: 'from users' },
				{ label: 'Onboarding', value: a.onboarding_completed ? 'Complete' : 'Incomplete', own: 'local', note: 'accounts.onboarding_completed' },
				{ label: 'Users', value: `${data.summary.users} (${data.summary.active_users} active)`, own: 'sys' },
				{ label: 'Stores', value: `${data.summary.stores} (${data.summary.connected_stores} with persisted status “connected”)`, own: 'sys' },
				{ label: 'Service contracts', value: String(data.summary.contracts), own: 'sys' }
			] as Row[]
		},
		{
			title: 'IDs & system',
			rows: [
				{ label: 'Local ID', value: a.id, own: 'local', mono: true },
				{ label: 'Salesforce account', value: a.sfdc_account_id ?? 'not linked', own: 'local', mono: !!a.sfdc_account_id, note: 'the link to Salesforce' },
				{ label: 'Stripe customer', value: a.stripe_customer_id ?? 'not linked', own: 'sf', api: 'Account.Stripe_Customer_Id__c', mono: !!a.stripe_customer_id },
				{ label: 'Created', value: fmt(a.created_at), own: 'local' },
				{ label: 'Last updated', value: fmt(a.updated_at), own: 'local' }
			] as Row[]
		}
	];

	let editing = false;
	let previewing = false;
	let draft: Record<string, string> = {};
	let saving = false;
	let modal: 'create' | 'sync' | 'delete' | null = null;
	$: inSf = data.sfState === 'synced';
	function startEdit() { draft = Object.fromEntries(EDIT_FIELDS.map(([k]) => [k, get(k)])); editing = true; previewing = false; }
	function cancelEdit() { editing = false; previewing = false; }
	$: changes = editing ? EDIT_FIELDS.filter(([k]) => (draft[k] ?? '').trim() !== get(k).trim()).map(([k, l]) => ({ name: k, label: l, from: get(k), to: (draft[k] ?? '').trim() })) : [];
	$: canSave = editing && !!(draft.name ?? '').trim() && changes.length > 0;
	$: if (form && 'result' in form && form.result) { editing = false; previewing = false; }
</script>

<svelte:head><title>{a.name} — Admin</title></svelte:head>

{#if form && 'ok' in form && typeof form.ok === 'string'}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}
{#if form && 'result' in form && form.result}
	{@const r = form.result}
	<div class="adm-alert {r.salesforce === 'failed' ? 'warn' : 'ok'}" role="status">
		Saved locally ({r.changed.join(', ')}).
		{#if r.salesforce === 'synced'}Synced to Salesforce.
		{:else if r.salesforce === 'failed'}Salesforce sync FAILED: {r.salesforceError}. The local change is saved; Salesforce still has the old value.
		{:else if r.salesforce === 'not_linked'}Not synced — this account has no Salesforce link.
		{:else}These fields are local only.{/if}
	</div>
{/if}

<div class="sfbar" role="status" style="background:{bn[2]};border-color:{bn[3]};color:{bn[4]}">
	<span><strong>{bn[0]}</strong> — {bn[1]}
		{#if a.sfdc_account_id}<button type="button" class="idbtn" title="Copy Salesforce ID" on:click={() => copy(a.sfdc_account_id ?? '')}>{a.sfdc_account_id}</button>{/if}</span>
	<span class="obj">Salesforce object <code>Account</code></span>
</div>

<div class="adm-card card">
	<div class="head">
		<div>
			<h2>Setup summary</h2>
			<div class="adm-muted">{editing ? 'Editing Salesforce-backed fields. Local and derived values stay read-only.' : 'Account fields, ownership and IDs'}</div>
		</div>
		<div class="btns">
			{#if editing}
				<button type="button" class="adm-btn outline" on:click={cancelEdit}>Cancel</button>
				<button type="button" class="adm-btn" disabled={!canSave} title={changes.length === 0 ? 'Change a field first' : ''} on:click={() => (previewing = true)}>Save</button>
			{:else}
				<button type="button" class="adm-btn outline" disabled={!data.canEdit} title={data.canEdit ? '' : 'Your role is read-only'} on:click={startEdit}>Edit</button>
				<button type="button" class="adm-btn outline" disabled={!data.canEdit || inSf || data.sfState === 'unknown'} title={inSf ? 'Already in Salesforce — use Sync to update it' : 'Create this account in Salesforce'} on:click={() => (modal = 'create')}>＋ Create in Salesforce</button>
				<button type="button" class="adm-btn outline" disabled={!data.canEdit || !inSf} title={inSf ? 'Push current values to Salesforce' : 'Not in Salesforce yet — create it first'} on:click={() => (modal = 'sync')}>⟳ Sync</button>
				<button type="button" class="adm-btn outline danger-text" disabled={!data.canDelete} on:click={() => (modal = 'delete')}>Delete</button>
			{/if}
		</div>
	</div>

	<div class="legend">
		<span>Where each value lives:</span>
		<span><span class="own" style="background:#DBEAFE;color:#1d4ed8">Salesforce</span> saved here, pushed to the field shown</span>
		<span><span class="own" style="background:#F1F5F9;color:#475569">Local only</span> exists only in this app</span>
		<span><span class="own" style="background:#FEF3C7;color:#92400e">Derived</span> calculated, not editable</span>
	</div>

	<div class="adm-table-wrap">
		<div class="grid th"><span>Field</span><span>Value</span><span class="c">Synced to SF</span><span>Salesforce API name</span><span>Source</span></div>
		{#each groups as g}
			<div class="gt">{g.title}</div>
			{#each g.rows as r}
				{@const o = OWN[r.own]}
				<div class="grid row" class:editrow={editing && r.key}>
					<span class="lbl">{r.label}</span>
					<div class="val">
						{#if editing && r.key}
							<input class="adm-input" bind:value={draft[r.key]} aria-label={r.label} required={r.key === 'name'} maxlength="300" style={r.key === 'name' && !(draft.name ?? '').trim() ? 'border-color:#fca5a5' : ''} />
						{:else if r.mono && r.value !== '—' && r.value !== 'not linked'}
							<button type="button" class="copy" title="Click to copy" on:click={() => copy(r.value)}>{r.value}</button>
						{:else}
							<span>{r.value}</span>
						{/if}
						{#if r.note && !(editing && r.key)}<span class="adm-muted note">{r.note}</span>{/if}
					</div>
					<span class="c"><input type="checkbox" checked={r.own === 'sf'} disabled aria-label={r.own === 'sf' ? 'Synced to Salesforce' : 'Not synced to Salesforce'} /></span>
					<span>{#if r.api}<code>{r.api}</code>{:else}<span class="adm-muted">—</span>{/if}</span>
					<span><span class="own" style="background:{o[1]};color:{o[2]}">{o[0]}</span></span>
				</div>
			{/each}
		{/each}
	</div>
</div>

<!-- Preview of changes before they are saved -->
{#if previewing}
	<div class="backdrop" role="presentation" on:click={() => (previewing = false)}>
		<div class="modal" role="dialog" aria-modal="true" aria-label="Preview changes" tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
			<header><h3>Preview — {changes.length} change{changes.length === 1 ? '' : 's'}</h3><button type="button" class="x" aria-label="Close" on:click={() => (previewing = false)}>✕</button></header>
			<div class="mbody">
				{#if !a.sfdc_account_id}<div class="adm-alert warn">This account is not linked to Salesforce, so changes will be saved locally only.</div>{/if}
				<div class="adm-table-wrap"><table class="adm-table">
					<caption class="adm-sr">Changes to be saved</caption>
					<thead><tr><th scope="col">Field</th><th scope="col">Current</th><th scope="col">New value</th><th scope="col">Saved to</th></tr></thead>
					<tbody>
						{#each changes as c}
							<tr><td>{c.label}</td><td style="color:#b91c1c;text-decoration:line-through">{c.from || '—'}</td><td style="color:#047857;font-weight:600">{c.to || '—'}</td>
								<td>Local database{a.sfdc_account_id ? ` + Account.${data.sfFields[c.name]}` : ''}</td></tr>
						{/each}
					</tbody>
				</table></div>
			</div>
			<form method="POST" action="?/update" use:enhance={() => { saving = true; return async ({ update }) => { await update({ reset: false }); saving = false; previewing = false; }; }}>
				<input type="hidden" name="version" value={a.version} />
				{#each EDIT_FIELDS as [name]}<input type="hidden" {name} value={draft[name] ?? ''} />{/each}
				<footer>
					<button type="button" class="adm-btn outline" on:click={() => (previewing = false)}>Back to editing</button>
					<button class="adm-btn" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Confirm & save'}</button>
				</footer>
			</form>
		</div>
	</div>
{/if}

{#if modal === 'sync' || modal === 'create'}
	<RecordModal kind="sync" title={modal === 'create' ? 'Create account in Salesforce' : 'Sync account to Salesforce'}
		body={modal === 'create'
			? `Creates the Salesforce Account and the owner’s Contact${a.sfdc_account_id ? ` (replacing the stale link ${a.sfdc_account_id})` : ''}, then links them. Use this when the account was never created or creation failed. Logged with your reason.`
			: `Pushes the app’s current values for this account to Salesforce Account ${a.sfdc_account_id}, overwriting what is there. Logged with your reason.`}
		recordName={a.name} recordId={a.id} action="?/resync" hidden={{ kind: 'account', targetId: a.id, mode: modal === 'create' ? 'create' : 'update' }}
		submitLabel={modal === 'create' ? 'Create in Salesforce' : 'Push current values'} on:close={() => (modal = null)} />
{:else if modal === 'delete'}
	<RecordModal kind="delete" title="Permanently delete account"
		body="This deletes the account and all related records from the database (users, stores, documents, contracts, logs). Salesforce and Stripe are not touched. This cannot be undone."
		recordName={a.name} recordId={a.id} action="?/delete" confirmText={a.name} submitLabel="Permanently delete account"
		error={data.freshMfa ? null : 'MFA verification required — your last verification was over 15 minutes ago. Re-verify before deleting.'}
		on:close={() => (modal = null)} />
	{#if !data.freshMfa}<a class="mfa" href="/admin/reauth?next={encodeURIComponent($page.url.pathname)}">Verify MFA</a>{/if}
{/if}

<style>
	.sfbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; border: 1px solid; border-radius: 10px; padding: 10px 16px; font-size: 13px; margin-bottom: 16px; }
	.idbtn { background: rgba(255,255,255,.7); border: 1px solid currentColor; border-radius: 6px; padding: 0 6px; margin-left: 6px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: inherit; cursor: pointer; }
	.obj { font-size: 12px; } .obj code { background: rgba(255,255,255,.7); padding: 1px 6px; border-radius: 5px; }
	.card { padding: 0; }
	.head { display: flex; justify-content: space-between; gap: 12px; align-items: center; flex-wrap: wrap; padding: 16px 20px; border-bottom: 1px solid var(--grey-line); }
	.head h2 { margin: 0 0 2px; font-size: 16px; }
	.btns { display: flex; gap: 8px; }
	.danger-text { color: #b91c1c; }
	.legend { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; padding: 10px 20px; font-size: 12px; color: var(--grey-text); border-bottom: 1px solid var(--grey-line); background: #fafbfd; }
	.own { display: inline-block; padding: 1px 9px; border-radius: 10px; font-size: 11px; font-weight: 700; white-space: nowrap; }
	.grid { display: grid; grid-template-columns: 1.1fr 2.2fr .7fr 1.6fr .9fr; gap: 12px; align-items: center; padding: 10px 20px; font-size: 13px; }
	.grid.th { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); background: #fafbfd; border-bottom: 1px solid var(--grey-line); }
	.grid.row { border-top: 1px solid var(--grey-line); }
	.grid.row:hover { background: #FAFBFD; }
	.grid.editrow { background: #FFFBF0; }
	.gt { padding: 8px 20px; font-size: 12px; font-weight: 800; color: var(--navy); background: #F1F4F9; border-top: 1px solid var(--grey-line); }
	.c { text-align: center; }
	.lbl { font-weight: 600; color: var(--navy); }
	.val { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; word-break: break-word; }
	.val .adm-input { width: 100%; }
	.note { font-size: 11px; }
	code { font-size: 11px; background: #F1F4F9; padding: 1px 6px; border-radius: 5px; }
	.copy { background: none; border: none; padding: 0; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--navy); cursor: pointer; text-align: left; word-break: break-all; }
	.copy:hover { text-decoration: underline; }
	.backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.55); z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 24px; }
	.modal { background: #fff; border-radius: 12px; width: min(720px, 100%); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.25); }
	.modal header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--grey-line); }
	.modal h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy); }
	.x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); }
	.mbody { padding: 18px; overflow: auto; }
	.modal footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--grey-line); }
	.mfa { position: fixed; z-index: 1400; right: 24px; bottom: 24px; background: var(--navy); color: #fff; padding: 8px 14px; border-radius: 8px; font-weight: 700; text-decoration: none; }
	@media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } .grid.th { display: none; } }
</style>
