<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	let busy = false;
	$: done = form && 'ok' in form && form.ok ? form.ok : null;
	$: failed = form && 'error' in form ? form.error : null;
	const money = (cents: string | number, cur: string) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(Number(cents) / 100);
	const day = (d: Date | string) => new Date(d).toISOString().slice(0, 10);
</script>

<svelte:head><title>Review merge — Admin</title></svelte:head>

<p><a href="/admin/accounts/merge">← Back to Account merge</a></p>
<h1 class="adm-h1">Review merge</h1>

{#if done}
	<div class="adm-alert ok" role="status">
		<strong>Merged.</strong> Moved {done.moved.users} login{done.moved.users === 1 ? '' : 's'} ({done.moved.disabled} disabled), {done.moved.stores} store{done.moved.stores === 1 ? '' : 's'},
		{done.moved.contracts} contract{done.moved.contracts === 1 ? '' : 's'}, {done.moved.contacts} contact{done.moved.contacts === 1 ? '' : 's'} and {done.moved.activity} activity record{done.moved.activity === 1 ? '' : 's'}.
		<a href="/admin/accounts/{done.keep}">Open the final account →</a>
		<div class="adm-muted" style="margin-top:6px">
			{#if !done.salesforce.attempted}Salesforce: not updated{done.salesforce.note ? ` — ${done.salesforce.note}` : ''}.
			{:else}Salesforce: {done.salesforce.ok} record{done.salesforce.ok === 1 ? '' : 's'} updated{done.salesforce.failed.length ? `, ${done.salesforce.failed.length} failed` : ''}. {done.salesforce.note ?? ''}{/if}
		</div>
		{#each done.salesforce.failed as f}<div class="adm-muted">⚠ {f.object} {f.id}: {f.error}</div>{/each}
	</div>
{:else if data.error}
	<div class="adm-alert error" role="alert">{data.error}</div>
{:else if data.survivor && data.source && data.defaults}
	{@const S = data.survivor}
	{@const T = data.source}
	<p class="adm-sub">
		<strong>{T.account.name}</strong> will be merged <em>into</em> <strong>{S.account.name}</strong>. Choose what the final account keeps. Anything you leave unselected stays on
		the retired account (nothing is deleted). <a href="/admin/accounts/merge/review?keep={T.account.id}&from={S.account.id}">Swap which account stays ⇄</a>
	</p>
	{#if failed}<div class="adm-alert error" role="alert">{failed}</div>{/if}
	{#if !data.canMerge}<div class="adm-alert warn">Your role is read-only; you can review but not merge.</div>{/if}

	<form method="POST" action="?/merge" use:enhance={() => { busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; }; }}>
		<input type="hidden" name="keep" value={S.account.id} />
		<input type="hidden" name="from" value={T.account.id} />

		<section class="adm-card">
			<h2>1 · Account details</h2>
			<p class="adm-muted">Pick the value the final account should have. Rows that are identical are not shown.</p>
			<table class="adm-table">
				<thead><tr><th>Field</th><th>Keep from {S.account.name} (final)</th><th>Use from {T.account.name}</th></tr></thead>
				<tbody>
					{#each data.fields.filter((f) => (f.survivor ?? '') !== (f.source ?? '')) as f}
						<tr>
							<td>{f.label}</td>
							<td><label class="opt"><input type="radio" name="f_{f.key}" value="survivor" checked={!(f.source && !f.survivor)} /> {f.survivor ?? '—'}</label></td>
							<td><label class="opt"><input type="radio" name="f_{f.key}" value="source" checked={!!(f.source && !f.survivor)} /> {f.source ?? '—'}</label></td>
						</tr>
					{:else}
						<tr><td colspan="3" class="adm-muted">The two accounts have identical details.</td></tr>
					{/each}
					{#if S.account.stripe_customer_id !== T.account.stripe_customer_id}
						<tr>
							<td>Stripe customer</td>
							<td><label class="opt"><input type="radio" name="stripe" value="survivor" checked={data.defaults.stripe === 'survivor'} /> <span class="adm-mono">{S.account.stripe_customer_id ?? '—'}</span></label></td>
							<td><label class="opt"><input type="radio" name="stripe" value="source" checked={data.defaults.stripe === 'source'} disabled={!T.account.stripe_customer_id} /> <span class="adm-mono">{T.account.stripe_customer_id ?? '—'}</span></label></td>
						</tr>
					{/if}
				</tbody>
			</table>
		</section>

		<section class="adm-card">
			<h2>2 · Logins (credentials)</h2>
			<p class="adm-muted">Passwords stay with each person. Choose who can sign in to the final account and their role — exactly one must be <em>owner</em>. Disabled logins cannot sign in (nothing is deleted).</p>
			<table class="adm-table">
				<thead><tr><th>Login</th><th>From</th><th>Current role</th><th>In the final account</th></tr></thead>
				<tbody>
					{#each [...S.users.map((u) => ({ u, from: S.account.name })), ...T.users.map((u) => ({ u, from: T.account.name }))] as row (row.u.id)}
						<tr>
							<td>{row.u.display_name ?? ''} <span class="adm-muted">{row.u.email}</span>{#if !row.u.is_active} <span class="adm-muted">(inactive)</span>{/if}</td>
							<td>{row.from}</td>
							<td>{row.u.role}</td>
							<td>
								<select name="u_{row.u.id}" aria-label="Role for {row.u.email}">
									{#each ['owner', 'admin', 'member', 'disable'] as r}
										<option value={r} selected={data.defaults.users[row.u.id] === r}>{r === 'disable' ? 'Disable login' : `Keep as ${r}`}</option>
									{/each}
								</select>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</section>

		<section class="adm-card">
			<h2>3 · Data to move into {S.account.name}</h2>
			<div class="grid">
				<div>
					<h3>Stores <span class="adm-muted">(with their documents, cases and chat)</span></h3>
					{#each T.stores as s}
						<label class="opt"><input type="checkbox" name="storeId" value={s.id} checked /> {s.name}{#if s.seller_id} <span class="adm-muted">({s.seller_id})</span>{/if}</label>
					{:else}<p class="adm-muted">No stores.</p>{/each}
				</div>
				<div>
					<h3>Contracts <span class="adm-muted">(with line items and payments)</span></h3>
					{#each T.contracts as k}
						<label class="opt"><input type="checkbox" name="contractId" value={k.id} checked /> {k.kind} · {money(k.amount_cents, k.currency)} · {day(k.paid_at)} <span class="adm-muted">{k.status}</span></label>
					{:else}<p class="adm-muted">No contracts.</p>{/each}
				</div>
			</div>
			<label class="opt"><input type="checkbox" name="contacts" checked /> Contacts ({T.contactCount}) — contacts whose email already exists in the final account are skipped</label>
			<label class="opt"><input type="checkbox" name="activity" checked /> Activity history ({T.activityCount})</label>
			<p class="adm-muted">The final account currently has {S.stores.length} store{S.stores.length === 1 ? '' : 's'} and {S.contracts.length} contract{S.contracts.length === 1 ? '' : 's'}; they stay.</p>
		</section>

		<section class="adm-card">
			<h2>4 · Salesforce</h2>
			<label class="opt"><input type="checkbox" name="salesforce" checked={data.defaults.salesforce} disabled={!S.account.sfdc_account_id || !T.account.sfdc_account_id} />
				Re-parent the moved stores, contracts and contacts to the final Salesforce account, and apply chosen account details there</label>
			<p class="adm-muted">Final: <span class="adm-mono">{S.account.sfdc_account_id ?? 'not linked'}</span> · Retired: <span class="adm-mono">{T.account.sfdc_account_id ?? 'not linked'}</span>.
				Cases and other records not tracked in the platform are not moved — merge those with Salesforce's own Merge Accounts.</p>
		</section>

		<section class="adm-card">
			<h2>5 · Confirm</h2>
			<div class="adm-row">
				<label class="grow">Reason (audited)<input name="reason" required minlength="5" maxlength="500" placeholder="e.g. Same client registered twice; keeping the Salesforce-originated account" /></label>
				<label class="grow">Type the final account's name to confirm: <strong>{S.account.name}</strong><input name="confirm" required autocomplete="off" /></label>
			</div>
			<div class="actions"><button class="adm-btn" type="submit" disabled={busy || !data.canMerge}>{busy ? 'Merging…' : 'Merge accounts'}</button></div>
		</section>
	</form>
{/if}

<style>
	h2 { font-size: 16px; margin: 0 0 6px; color: var(--navy); }
	h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); margin: 4px 0 6px; }
	.opt { display: block; margin: 5px 0; }
	.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-bottom: 10px; }
	.grow { flex: 1; min-width: 260px; }
	.actions { display: flex; justify-content: flex-end; margin-top: 4px; }
	select { border: 1.5px solid var(--grey-line); border-radius: 8px; padding: 6px 8px; font-size: 13px; background: #fff; color: var(--navy); }
	@media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
</style>
