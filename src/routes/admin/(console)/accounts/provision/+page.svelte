<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	let busy = '';
	$: done = form && 'ok' in form && form.ok ? form.ok : null;
	$: failed = form && 'error' in form ? form : null;
	const fmt = (d: string | null) => d ?? '—';
</script>

<svelte:head><title>Account provision — Admin</title></svelte:head>

<h1 class="adm-h1">Account provision</h1>
<p class="adm-sub">
	Salesforce accounts that have service contracts but no platform account. Provisioning links the <em>existing</em> Salesforce records to a new platform
	account (nothing is created in Salesforce), so the client's contracts and payments appear in the platform. Related stores can be provisioned with it.
</p>

{#if done}
	<div class="adm-alert ok" role="status">
		<strong>Provisioned.</strong> Platform account created ({done.stores} store{done.stores === 1 ? '' : 's'}).
		<a href="/admin/accounts/{done.accountId}">Open account →</a>
		{#if done.temporaryPassword}
			<div style="margin-top:8px">One-time temporary password (shown once — the client must change it at first sign-in):
				<span class="adm-mono" style="user-select:all">{done.temporaryPassword}</span></div>
		{/if}
		{#each done.warnings as w}<div class="adm-muted">⚠ {w}</div>{/each}
	</div>
{/if}
{#if failed}<div class="adm-alert error" role="alert">{failed.error}</div>{/if}
{#if data.sfError}<div class="adm-alert error" role="alert">Could not read Salesforce, so the list below is empty: {data.sfError}</div>{/if}

<form method="GET" class="adm-card" role="search">
	<div class="adm-row">
		<label>Search (company, email, Salesforce ID, contract)
			<input type="search" name="q" value={data.q} style="min-width:300px" />
		</label>
		<button class="adm-btn" type="submit">Search</button>
	</div>
	<p class="adm-muted" style="margin:8px 0 0">
		{data.candidates.length} not provisioned · {data.alreadyLinked} already linked
		{#if data.truncated} · showing the newest 2000 contracts only{/if}
	</p>
</form>

<div class="adm-card">
	{#if data.candidates.length === 0 && !data.sfError}
		<div class="adm-empty">Every Salesforce account with a contract is already on the platform.</div>
	{/if}
	{#each data.candidates as c (c.sfdcAccountId)}
		<details class="cand">
			<summary>
				<span class="nm">{c.name}</span>
				<span class="adm-mono adm-muted">{c.sfdcAccountId}</span>
				<span class="adm-muted">{c.contracts.length} contract{c.contracts.length === 1 ? '' : 's'} · {c.stores.length} store{c.stores.length === 1 ? '' : 's'}</span>
				{#if c.matches.length}<span class="warnchip">Possible existing platform account</span>{/if}
			</summary>

			{#if c.matches.length}
				<div class="adm-alert warn" role="note">
					A platform account may already exist for this client. Provisioning would create a duplicate — check these first and use
					<a href="/admin/accounts/merge">Account merge</a> instead:
					<ul>
						{#each c.matches as m}
							<li><a href="/admin/accounts/{m.accountId}">{m.name}</a> <span class="adm-muted">(matched by {m.reason}{m.sfdcAccountId ? `, linked to ${m.sfdcAccountId}` : ', not linked to Salesforce'})</span></li>
						{/each}
					</ul>
				</div>
			{/if}

			<div class="cols">
				<div>
					<h3>Contracts</h3>
					<ul>{#each c.contracts as k}<li>{k.name} <span class="adm-muted">{fmt(k.startDate)} → {fmt(k.endDate)}</span></li>{/each}</ul>
				</div>
				<div>
					<h3>Contacts</h3>
					<ul>{#each c.contacts as k}<li>{k.name || '(no name)'} <span class="adm-muted">{k.email ?? 'no email'}</span></li>{:else}<li class="adm-muted">None</li>{/each}</ul>
				</div>
			</div>

			{#if data.canProvision}
				<form method="POST" action="?/provision" use:enhance={() => { busy = c.sfdcAccountId; return async ({ update }) => { await update({ reset: false }); busy = ''; }; }}>
					<input type="hidden" name="sfdcAccountId" value={c.sfdcAccountId} />
					<fieldset class="adm-fieldset">
						<legend>Provision on the platform</legend>
						{#if c.stores.length}
							<div class="adm-field">Stores to provision:
								{#each c.stores as s}
									<label class="chk"><input type="checkbox" name="storeId" value={s.id} checked /> {s.name}
										{#if s.sellerId}<span class="adm-muted">({s.sellerId})</span>{/if}</label>
								{/each}
							</div>
						{/if}
						<label class="chk"><input type="checkbox" name="createLogin" checked /> Create an owner login (temporary password, must be changed at first sign-in)</label>
						<div class="adm-row fields">
							<label>Login contact
								<select name="sfdcContactId">
									{#each c.contacts.filter((k) => k.email) as k}<option value={k.id}>{k.name || k.email} — {k.email}</option>{/each}
								</select>
							</label>
							<label class="grow">Reason (audited)
								<input name="reason" required minlength="5" maxlength="500" placeholder="e.g. Client onboarded in Salesforce; needs platform access" />
							</label>
						</div>
						<div class="actions">
							<button class="adm-btn sm" type="submit" disabled={busy === c.sfdcAccountId}>{busy === c.sfdcAccountId ? 'Provisioning…' : 'Provision'}</button>
						</div>
					</fieldset>
				</form>
			{:else}
				<p class="adm-muted">Your role is read-only; ask a platform admin to provision this account.</p>
			{/if}
		</details>
	{/each}
</div>

<style>
	.cand { border: 1px solid var(--grey-line); border-radius: 10px; margin-bottom: 10px; padding: 0 14px; }
	.cand summary { cursor: pointer; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; padding: 12px 0; }
	.nm { font-weight: 700; color: var(--navy); }
	.warnchip { background: #FEF3C7; color: #92400e; border-radius: 10px; padding: 2px 9px; font-size: 11px; font-weight: 700; }
	.cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
	.cols h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); margin: 8px 0 4px; }
	.cols ul { margin: 0; padding-left: 18px; }
	.chk { display: block; margin: 4px 0; }
	.fields { margin-bottom: 0; }
	.fields .grow { flex: 1; min-width: 260px; }
	.fields select { min-width: 280px; }
	.actions { display: flex; justify-content: flex-end; }
	.adm-fieldset { border: 1px solid var(--grey-line); border-radius: 8px; padding: 10px 14px; margin: 12px 0 14px; display: grid; gap: 10px; }
	@media (max-width: 800px) { .cols { grid-template-columns: 1fr; } }
</style>
