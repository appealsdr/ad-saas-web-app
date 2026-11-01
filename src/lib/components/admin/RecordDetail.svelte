<script lang="ts">
	import { enhance } from '$app/forms';
	import RecordModal from './RecordModal.svelte';

	/**
	 * Admin record detail — the same layout as the account Overview:
	 * Salesforce banner, action buttons, and a Field / Value / Synced to SF /
	 * Salesforce API name / Source table. Related lists go in the default slot.
	 */
	interface Row { key: string; label: string; value: string; own: 'sf' | 'local' | 'sys'; api?: string; mono?: boolean; note?: string; href?: string; editable?: boolean; inputType?: string; inputValue?: string }
	export let title: string;
	export let kindLabel: string;
	export let recordId: string;
	export let syncKind: 'account' | 'user' | 'store' | 'contract' | null = null;
	export let groups: { title: string; rows: Row[] }[];
	export let sfObject: string | null = null;
	export let sfId: string | null = null;
	export let sfState: 'synced' | 'not_in_sf' | 'unknown' = 'not_in_sf';
	export let sfUrl: string | null = null;
	export let canEdit = false;
	export let canSync = false;
	export let canDelete = false;
	/** False for records that live only in Salesforce/Stripe (cases, payments). */
	export let showEdit = true;
	export let showDelete = true;
	export let deleteConfirm = '';
	export let startEditing = false;
	export let message: string | null = null;
	export let error: string | null = null;
	export let backHref: string;
	export let backLabel = 'Back to list';

	const BANNER = {
		synced: ['Synced', 'This record exists in Salesforce.', '#ECFDF5', '#86efac', '#166534'],
		not_in_sf: ['Not in Salesforce', '', '#FEF2F2', '#fca5a5', '#b91c1c'],
		unknown: ['Unknown', 'Salesforce could not be reached, so the sync state is unknown.', '#FFFBEB', '#fcd34d', '#92400e']
	} as const;
	const OWN = { sf: ['Salesforce', '#DBEAFE', '#1d4ed8'], local: ['Local only', '#F1F5F9', '#475569'], sys: ['Derived', '#FEF3C7', '#92400e'] } as const;
	$: bn = BANNER[sfState];
	$: bnText = sfState === 'not_in_sf' ? (sfId ? 'The stored Salesforce link points to a record Salesforce no longer has.' : 'This record has not been created in Salesforce.') : bn[1];
	$: editableCount = groups.reduce((n, g) => n + g.rows.filter((r) => r.editable).length, 0);

	let editing = startEditing && canEdit && editableCount > 0;
	let saving = false;
	let modal: 'create' | 'sync' | 'repair' | 'delete' | null = null;
	$: inSf = sfState === 'synced';
	$: sfDown = sfState === 'unknown';
	$: if (message) editing = false;
	async function copy(t: string) { try { await navigator.clipboard.writeText(t); } catch { /* needs user gesture */ } }
</script>

<p class="back"><a href={backHref}>← {backLabel}</a></p>
{#if message}<div class="adm-alert ok" role="status">{message}</div>{/if}
{#if error}<div class="adm-alert error" role="alert">{error}</div>{/if}

<div class="sfbar" role="status" style="background:{bn[2]};border-color:{bn[3]};color:{bn[4]}">
	<span><strong>{bn[0]}</strong>{bnText ? ` — ${bnText}` : ''}
		{#if sfId}<button type="button" class="idbtn" title="Copy Salesforce ID" on:click={() => copy(sfId ?? '')}>{sfId}</button>{/if}</span>
	{#if sfObject}<span class="obj">Salesforce object <code>{sfObject}</code></span>{/if}
</div>

<form method="POST" action="?/update" use:enhance={() => { saving = true; return async ({ update }) => { await update({ reset: false }); saving = false; }; }}>
	<div class="adm-card card">
		<div class="head">
			<div>
				<div class="kind">{kindLabel}</div>
				<h2>{title}</h2>
				<div class="adm-muted">{editing ? 'Editing Salesforce-backed fields. Local and derived values stay read-only.' : 'Record fields, ownership and IDs'}</div>
			</div>
			<div class="btns">
				{#if editing}
					<button type="button" class="adm-btn outline" on:click={() => (editing = false)}>Cancel</button>
					<button type="submit" class="adm-btn" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
				{:else}
					{#if showEdit}<button type="button" class="adm-btn outline" disabled={!canEdit || editableCount === 0} title={editableCount === 0 ? 'This record has no editable fields' : canEdit ? '' : 'Your role is read-only'} on:click={() => (editing = true)}>Edit</button>{/if}
					{#if syncKind}
						<button type="button" class="adm-btn outline" disabled={!canSync || inSf || sfDown}
							title={inSf ? 'Already in Salesforce — use Sync to update it' : sfDown ? 'Salesforce could not be reached' : 'Create this record in Salesforce'}
							on:click={() => (modal = 'create')}>＋ Create in Salesforce</button>
						<button type="button" class="adm-btn outline" disabled={!canSync || !inSf}
							title={inSf ? 'Push current values to the existing Salesforce record' : 'Not in Salesforce yet — create it first'}
							on:click={() => (modal = 'sync')}>⟳ Sync to Salesforce</button>
						{#if syncKind === 'contract'}
							<button type="button" class="adm-btn outline" disabled={!canSync || !inSf}
								title={inSf ? 'Create any line items, cases or payments Salesforce is missing for this contract' : 'Not in Salesforce yet — create it first'}
								on:click={() => (modal = 'repair')}>🛠 Complete missing records</button>
						{/if}
					{/if}
					{#if sfUrl}<a class="adm-btn outline" href={sfUrl} target="_blank" rel="noopener">View in Salesforce ↗</a>{/if}
					<slot name="links" />
					{#if showDelete}<button type="button" class="adm-btn outline danger-text" disabled={!canDelete} title={canDelete ? '' : 'Your role cannot delete'} on:click={() => (modal = 'delete')}>Delete</button>{/if}
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
					<div class="grid row" class:editrow={editing && r.editable}>
						<span class="lbl">{r.label}</span>
						<div class="val">
							{#if editing && r.editable}
								<input class="adm-input" name={r.key} type={r.inputType ?? 'text'} value={r.inputValue ?? ''} aria-label={r.label} maxlength="1000" />
							{:else if r.href}
								<a href={r.href} target="_blank" rel="noopener" class="mono">{r.value} ↗</a>
							{:else if r.mono && r.value !== '—'}
								<button type="button" class="copy" title="Click to copy" on:click={() => copy(r.value)}>{r.value}</button>
							{:else}
								<span>{r.value}</span>
							{/if}
							{#if r.note && !(editing && r.editable)}<span class="adm-muted note">{r.note}</span>{/if}
						</div>
						<span class="c"><input type="checkbox" checked={r.own === 'sf'} disabled aria-label={r.own === 'sf' ? 'Synced to Salesforce' : 'Not synced to Salesforce'} /></span>
						<span>{#if r.api}<code>{r.api}</code>{:else}<span class="adm-muted">—</span>{/if}</span>
						<span><span class="own" style="background:{o[1]};color:{o[2]}">{o[0]}</span></span>
					</div>
				{/each}
			{/each}
		</div>
	</div>
</form>

<slot />

{#if (modal === 'sync' || modal === 'create' || modal === 'repair') && syncKind}
	<RecordModal kind="sync" title={modal === 'create' ? 'Create in Salesforce' : modal === 'repair' ? 'Complete missing Salesforce records' : 'Sync to Salesforce'}
		body={modal === 'create'
			? `Creates this record in Salesforce${sfId ? ` (replacing the stale link ${sfId})` : ''} and stores the new Salesforce ID. Use this when it was never created or creation failed. Logged with your reason.`
			: modal === 'repair'
				? 'Checks the Salesforce contract and creates only what is missing: contract line items, one case per line item, the collected payment, and a pending balance payment for each deposit service. Nothing existing is changed. Logged with your reason.'
				: `Pushes this record’s current values to the existing Salesforce record${sfId ? ` (${sfObject} ${sfId})` : ''}. Logged with your reason.`}
		recordName={title} {recordId} action="?/resync" hidden={{ kind: syncKind, targetId: recordId, mode: modal === 'create' ? 'create' : modal === 'repair' ? 'repair' : 'update' }}
		submitLabel={modal === 'create' ? 'Create in Salesforce' : modal === 'repair' ? 'Complete missing records' : 'Push current values'} on:close={() => (modal = null)} />
{:else if modal === 'delete'}
	<RecordModal kind="delete" title="Delete record"
		body="Deletes this record from the app{sfId ? '. The linked Salesforce record is not deleted' : ''}. This cannot be undone. Requires a recent MFA verification."
		recordName={title} {recordId} action="?/delete" confirmText={deleteConfirm} submitLabel="Delete record" on:close={() => (modal = null)} />
{/if}

<style>
	.back { margin: 0 0 10px; font-size: 13px; }
	.sfbar { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; border: 1px solid; border-radius: 10px; padding: 10px 16px; font-size: 13px; margin-bottom: 16px; }
	.idbtn { background: rgba(255,255,255,.7); border: 1px solid currentColor; border-radius: 6px; padding: 0 6px; margin-left: 6px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: inherit; cursor: pointer; }
	.obj { font-size: 12px; } .obj code { background: rgba(255,255,255,.7); padding: 1px 6px; border-radius: 5px; }
	.card { padding: 0; }
	.head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap; padding: 16px 20px; border-bottom: 1px solid var(--grey-line); }
	.kind { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--grey-text); }
	.head h2 { margin: 2px 0; font-size: 18px; }
	.btns { display: flex; gap: 8px; flex-wrap: wrap; }
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
	.mono { font-family: ui-monospace, Menlo, monospace; font-size: 12px; }
	code { font-size: 11px; background: #F1F4F9; padding: 1px 6px; border-radius: 5px; }
	.copy { background: none; border: none; padding: 0; font-family: ui-monospace, Menlo, monospace; font-size: 12px; color: var(--navy); cursor: pointer; text-align: left; word-break: break-all; }
	.copy:hover { text-decoration: underline; }
	@media (max-width: 900px) { .grid { grid-template-columns: 1fr 1fr; } .grid.th { display: none; } }
</style>
