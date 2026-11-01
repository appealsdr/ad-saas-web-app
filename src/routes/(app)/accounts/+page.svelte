<script lang="ts">
	import { enhance } from '$app/forms';
	import Topbar from '$components/layout/Topbar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import { page } from '$app/stores';
	import PlansOverlay from '$lib/components/account/PlansOverlay.svelte';
	import PasswordInput from '$lib/components/ui/PasswordInput.svelte';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	type Contact = PageData['accountContacts'][number];
	type RecordId = 'billing' | 'contact' | 'account' | 'signin' | 'system';

	let plansOpen = $page.url.searchParams.get('plans') === '1';
	let saving = false;
	let syncing = false;
	let search = '';
	let openRecord: RecordId | null = null;
	let editing = false;
	let member: { mode: 'view' | 'add' | 'edit'; contact?: Contact } | null = null;

	const fmtDate = (iso: string | null | undefined) => {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
	};
	const fmtDateTime = (iso: string | null | undefined) => {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleString(); } catch { return iso; }
	};
	const fmtNumber = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString());
	const fmtMoney = (n: number | null | undefined) => {
		if (n == null) return '—';
		try {
			return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n);
		} catch { return `$${n.toLocaleString()}`; }
	};
	const joinParts = (parts: (string | null | undefined)[]) => {
		const f = parts.filter((p): p is string => !!p && p.trim().length > 0);
		return f.length ? f.join(', ') : '—';
	};
	const initials = (c: Contact) =>
		((c.firstName?.[0] ?? '') + (c.lastName?.[0] ?? '')).toUpperCase() || '?';
	const fullName = (c: Contact) => [c.firstName, c.lastName].filter(Boolean).join(' ');

	async function copyId(id: string | null | undefined) {
		if (!id) return;
		try { await navigator.clipboard.writeText(id); } catch { /* needs a user gesture */ }
	}

	$: fv = form as Record<string, any> | null;
	$: canManage = data.userRole === 'owner' || data.userRole === 'admin';
	$: acct = data.account;
	$: ct = data.contact;
	$: accountName = acct?.Name ?? data.localAccount?.name ?? '—';
	// Account name, primary email and website: Salesforce first, then the app's own copy.
	$: accEmail = acct?.Primary_Email__c ?? data.localAccount?.email ?? null;
	$: accWebsite = acct?.Website ?? data.localAccount?.website ?? null;
	const href = (w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`);
	$: syncLabel = acct ? 'Synced' : data.accountError?.notFound ? 'Not found in SF' : data.accountError ? 'SF read error' : 'Not linked';
	$: syncVariant = (acct ? 'green' : data.accountError?.notFound ? 'grey' : 'orange') as 'green' | 'grey' | 'orange';

	$: billing = {
		street:     data.localAccount?.billingStreet     ?? acct?.BillingStreet     ?? '',
		city:       data.localAccount?.billingCity       ?? acct?.BillingCity       ?? '',
		state:      data.localAccount?.billingState      ?? acct?.BillingState      ?? '',
		postalCode: data.localAccount?.billingPostalCode ?? acct?.BillingPostalCode ?? '',
		country:    data.localAccount?.billingCountry    ?? acct?.BillingCountry    ?? ''
	};
	$: contactName = ct
		? [ct.Salutation, ct.FirstName, ct.LastName].filter(Boolean).join(' ')
		: data.localUser.displayName ?? data.localUser.email;

	$: customerSince = data.localAccount ? new Date(data.localAccount.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null;
	$: subtitleBits = [
		customerSince ? `Customer since ${customerSince}` : null,
		acct?.Industry ?? null,
		accEmail,
		accWebsite?.replace(/^https?:\/\//i, '').replace(/\/$/, '') ?? null,
		[billing.city, billing.state].filter(Boolean).join(', ') || null
	].filter(Boolean);

	$: plan = data.subscription;
	$: planPrice = plan?.price != null ? fmtMoney(plan.price) : null;

	$: team = data.accountContacts.filter((c) => {
		const q = search.trim().toLowerCase();
		return !q || `${fullName(c)} ${c.email} ${c.title ?? ''}`.toLowerCase().includes(q);
	});

	$: records = [
		{ id: 'account' as RecordId, name: 'Account Information', icon: '/icons/case.png', kind: 'Salesforce Account', desc: joinParts([accountName === '—' ? null : accountName, accEmail, accWebsite]), badge: acct ? 'Editable' : 'Not linked' },
		{ id: 'billing' as RecordId, name: 'Billing Address', icon: '/icons/payment.png', kind: 'Local account · mirrored to Salesforce Account', desc: joinParts([billing.street, billing.city, billing.state, billing.postalCode, billing.country]), badge: 'Editable' },
		{ id: 'contact' as RecordId, name: 'Primary Contact', icon: '/icons/account.png', kind: 'Salesforce Contact', desc: ct ? `${contactName}${ct.Title ? ' · ' + ct.Title : ''}` : 'No Salesforce Contact linked yet', badge: ct ? 'Editable' : 'Not linked' },
		{ id: 'signin' as RecordId, name: 'Connected Accounts', icon: '/icons/guidance.png', kind: 'Sign-in', desc: data.googleLinked ? 'Google · connected' : 'Link Google to sign in without a password', badge: data.googleLinked ? 'Connected' : 'Not connected' },
		{ id: 'system' as RecordId, name: 'System Information', icon: '/icons/file.png', kind: 'App user & Salesforce system fields', desc: `${data.localUser.email} · ${data.userRole ?? 'member'} · Last login ${fmtDate(data.localUser.lastLoginAt)}`, badge: 'Read-only' }
	];
	$: current = records.find((r) => r.id === openRecord) ?? null;

	function selectRecord(id: RecordId) { openRecord = id; editing = false; }
	function closeRecord() { openRecord = null; editing = false; }
	function closeMember() { member = null; }

	// Close overlays after a successful action response.
	$: if (form?.success || form?.contactSuccess) { member = null; editing = false; }
</script>

<svelte:head><title>Account — Appeals Doctor</title></svelte:head>

<Topbar title="Account" subtitle="Synced from Salesforce" />

<div class="content-area">
	{#if form?.error}<div class="alert alert-error" style="margin-bottom:14px">{form.error}</div>{/if}
	{#if form?.contactError}<div class="alert alert-error" style="margin-bottom:14px">{form.contactError}</div>{/if}
	{#if form?.success}<div class="alert alert-info" style="margin-bottom:14px">{form.success}</div>{/if}
	{#if form?.contactSuccess}<div class="alert alert-info" style="margin-bottom:14px">{form.contactSuccess}</div>{/if}

	<section class="hero">
		<div class="hero-main">
			<div class="hero-title">
				<h1>{accountName}</h1>
				<Badge variant={syncVariant}>{syncLabel}</Badge>
				{#if !data.sfdcIds.accountId || !data.sfdcIds.contactId}
					<form method="POST" action="?/sync" use:enhance={() => {
						syncing = true;
						return async ({ update }) => { await update(); syncing = false; };
					}}>
						<button class="btn btn-outline btn-sm" type="submit" disabled={syncing}>
							{syncing ? 'Syncing…' : 'Sync to Salesforce'}
						</button>
					</form>
				{/if}
			</div>
			{#if subtitleBits.length}<div class="hero-sub">{subtitleBits.join(' · ')}</div>{/if}
		</div>
		{#if plan}
			<button type="button" class="plan-chip" title="View subscription & plans" on:click={() => (plansOpen = true)}>
				<div>
					<span class="plan-label">{plan.planName ?? 'Subscription'} plan</span>
					{#if planPrice}<span class="plan-price">{planPrice}<small>/year</small></span>{/if}
					{#if plan.cancelling}<span class="plan-renews ending">Ends {fmtDate(plan.renews)} · cancelled</span>{:else}<span class="plan-renews">Renews {fmtDate(plan.renews)}</span>{/if}
				</div>
				<span class="chev">›</span>
			</button>
		{:else}
			<button type="button" class="btn btn-primary" on:click={() => (plansOpen = true)}>Subscribe · from $100/year ›</button>
		{/if}
	</section>

	{#if data.accountError && !data.accountError.notFound}
		<div class="alert alert-error" style="margin-bottom:16px">
			Could not load account from Salesforce: {data.accountError.message} — showing local data.
			Billing edits save locally and sync once Salesforce is reachable.
		</div>
	{/if}

	<div class="grid">
		<div class="card details">
			<div class="card-head"><h2>Account Details</h2><span class="muted">{records.length} records</span></div>
			<div class="rec-list">
				{#each records as r (r.id)}
					<button type="button" class="rec" on:click={() => selectRecord(r.id)} title={`Open ${r.name}`}>
						<span class="rec-icon"><img src={r.icon} alt="" /></span>
						<span class="rec-body">
							<span class="rec-name">{r.name}</span>
							<span class="rec-desc">{r.desc}</span>
						</span>
					</button>
				{/each}
			</div>
		</div>

		<div class="card team">
			<div class="card-head">
				<h2>Account Team</h2>
				<span class="muted">{data.accountContacts.length} member{data.accountContacts.length === 1 ? '' : 's'}</span>
			</div>
			<div class="search"><input type="search" placeholder="Search team members…" aria-label="Search team members" bind:value={search} /></div>
			<div class="team-list">
				{#each team as c (c.id)}
					<div class="member" role="button" tabindex="0" title="Open team member"
						on:click={() => (member = { mode: 'view', contact: c })}
						on:keydown={(e) => e.key === 'Enter' && (member = { mode: 'view', contact: c })}>
						<div class="avatar">{initials(c)}</div>
						<div class="member-body">
							<div class="member-top">
								<span class="member-name">{fullName(c)}</span>
								{#if c.userRole}<span class="role-tag">{c.userRole}</span>{/if}
								{#if c.isPointOfContact}<span class="poc-badge">★ Point of Contact</span>{/if}
							</div>
							<div class="member-meta">{c.email}{c.title ? ` · ${c.title}` : ''}{c.phone ? ` · ${c.phone}` : ''}</div>
							<div class="member-status">
								{#if c.userId}App user · can access stores
								{:else if c.inviteAcceptedAt}Registered user
								{:else if c.inviteSentAt}Invite pending
								{:else}Contact only{/if}
							</div>
						</div>
					</div>
				{:else}
					<p class="empty">{search ? 'No team members match your search.' : 'No team contacts yet.'}</p>
				{/each}
			</div>
			<div class="card-foot">
				<span class="muted">Members can use the app but cannot add contacts.</span>
				{#if canManage}
					<button class="btn btn-primary btn-sm" type="button" data-mutates on:click={() => (member = { mode: 'add' })}>+ Add Team Member</button>
				{/if}
			</div>
		</div>
	</div>
</div>

{#if plansOpen}
	<PlansOverlay {...data.plans} on:close={() => (plansOpen = false)} />
{/if}

<!-- ─── Team member modal ───────────────────────────────────────────── -->
{#if member}
	<div class="backdrop" role="presentation" on:click={closeMember}>
		<div class="modal" role="dialog" aria-modal="true" tabindex="-1"
			on:click|stopPropagation on:keydown|stopPropagation>
			<header>
				<h3>{member.mode === 'add' ? 'Add Team Member' : member.mode === 'edit' ? 'Edit Team Member' : fullName(member.contact ?? ({} as Contact))}</h3>
				<button type="button" class="x" aria-label="Close" on:click={closeMember}>✕</button>
			</header>

			{#if member.mode === 'view' && member.contact}
				{@const c = member.contact}
				<div class="modal-body">
					<div class="fields">
						<div><span>Email</span><strong>{c.email}</strong></div>
						<div><span>Phone</span><strong>{c.phone ?? '—'}</strong></div>
						<div><span>Title / Role</span><strong>{c.title ?? '—'}</strong></div>
						<div><span>App role</span><strong>{c.userRole ?? 'No app login'}</strong></div>
					</div>
				</div>
				<footer>
					{#if canManage && c.userRole !== 'owner'}
						<form method="POST" action="?/remove_account_contact" use:enhance
							on:submit={(e) => { if (!confirm(`Remove ${fullName(c)}?`)) e.preventDefault(); }}>
							<input type="hidden" name="contactId" value={c.id} />
							<button class="btn btn-outline btn-sm danger" type="submit">Remove</button>
						</form>
					{/if}
					<button class="btn btn-outline btn-sm" type="button" on:click={closeMember}>Close</button>
					{#if canManage && !c.isPointOfContact && c.userRole !== 'owner'}
						<form method="POST" action="?/set_point_of_contact" use:enhance>
							<input type="hidden" name="contactId" value={c.id} />
							<button class="btn btn-outline btn-sm" type="submit">★ Set as POC</button>
						</form>
					{/if}
					{#if canManage}
						<button class="btn btn-primary btn-sm" type="button" data-mutates on:click={() => (member = { mode: 'edit', contact: c })}>Edit</button>
					{/if}
				</footer>
			{:else if member.mode === 'edit' && member.contact}
				{@const c = member.contact}
				<form method="POST" action="?/update_account_contact" use:enhance={() => {
					saving = true;
					return async ({ update }) => { await update(); saving = false; };
				}}>
					<input type="hidden" name="contactId" value={c.id} />
					<div class="modal-body">
						<div class="inputs">
							<label><span>First Name</span><input class="form-control" name="firstName" value={c.firstName ?? ''} /></label>
							<label><span>Last Name *</span><input class="form-control" name="lastName" value={c.lastName} required /></label>
							<label><span>Phone</span><input class="form-control" name="phone" type="tel" value={c.phone ?? ''} /></label>
							<label><span>Title / Role</span><input class="form-control" name="title" value={c.title ?? ''} /></label>
						</div>
					</div>
					<footer>
						<button class="btn btn-outline btn-sm" type="button" on:click={closeMember}>Cancel</button>
						<button class="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
					</footer>
				</form>
			{:else if member.mode === 'add'}
				<form method="POST" action="?/add_account_contact" use:enhance={() => {
					saving = true;
					return async ({ update }) => { await update(); saving = false; };
				}}>
					<div class="modal-body">
						<div class="inputs">
							<label><span>First Name</span><input class="form-control" name="firstName" placeholder="First" /></label>
							<label><span>Last Name *</span><input class="form-control" name="lastName" placeholder="Last" required /></label>
							<label><span>Email *</span><input class="form-control" name="email" type="email" placeholder="email@example.com" required /></label>
							<label><span>Phone</span><input class="form-control" name="phone" type="tel" placeholder="+1 (555) 000-0000" /></label>
							<label class="full"><span>Title / Role</span><input class="form-control" name="title" placeholder="e.g. Operations Manager" /></label>
							<label><span>Password *</span><PasswordInput id="ac-password" name="password" placeholder="At least 8 characters" required minlength={8} autocomplete="new-password" /></label>
							<label><span>Confirm password *</span><PasswordInput id="ac-confirm" name="confirm" placeholder="Repeat password" required minlength={8} autocomplete="new-password" /></label>
						</div>
						<p class="hint">Creates a member account — they can sign in and work on stores, but cannot add or remove contacts.</p>
					</div>
					<footer>
						<button class="btn btn-outline btn-sm" type="button" on:click={closeMember}>Cancel</button>
						<button class="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Adding…' : 'Add Team Member'}</button>
					</footer>
				</form>
			{/if}
		</div>
	</div>
{/if}

<!-- ─── Account details records overlay ─────────────────────────────── -->
{#if current}
	<div class="overlay" role="dialog" aria-modal="true" aria-label="Account details">
		<div class="overlay-head">
			<div>
				<nav class="crumbs" aria-label="Breadcrumb">
					<button type="button" class="link" on:click={closeRecord}>Account</button><span>/</span>
					<span class="cur">Account Details</span>
				</nav>
				<h2>{current.name}</h2>
			</div>
			<button type="button" class="x" aria-label="Close" title="Close" on:click={closeRecord}>✕</button>
		</div>
		<div class="overlay-body">
			<aside>
				<div class="aside-head">Records <span class="muted">{records.length}</span></div>
				{#each records as r (r.id)}
					<button type="button" class="aside-item" class:active={r.id === current.id} on:click={() => selectRecord(r.id)}>
						<span>{r.name}</span><span class="muted">{r.badge}</span>
					</button>
				{/each}
			</aside>
			<section class="panel">
				<div class="panel-head">
					<div>
						<div class="kind">{current.kind}</div>
						<div class="panel-name">{current.name}</div>
					</div>
					<div class="panel-actions">
						{#if (current.id === 'billing' && data.localAccount) || (current.id === 'contact' && ct) || (current.id === 'account' && acct && canManage)}
							{#if !editing}<button class="btn btn-outline btn-sm" type="button" data-mutates on:click={() => (editing = true)}>Edit</button>{/if}
						{/if}
						{#if current.id === 'signin'}
							{#if data.googleLinked}
								<form method="POST" action="?/unlink_google" use:enhance><button class="btn btn-outline btn-sm" type="submit">Disconnect</button></form>
							{:else}
								<a class="btn btn-primary btn-sm" data-mutates href="/auth/google?link=1&next=/accounts">Connect Google Account</a>
							{/if}
						{/if}
					</div>
				</div>

				{#if current.id === 'billing'}
					{#if editing}
						<form method="POST" action="?/edit_billing_address" use:enhance={() => {
							saving = true;
							return async ({ update }) => { await update(); saving = false; };
						}}>
							<div class="inputs">
								<label class="full"><span>Street</span><input class="form-control" name="billingStreet" value={form?.billingStreet ?? billing.street} /></label>
								<label><span>City</span><input class="form-control" name="billingCity" value={form?.billingCity ?? billing.city} /></label>
								<label><span>State / Province</span><input class="form-control" name="billingState" value={form?.billingState ?? billing.state} /></label>
								<label><span>Postal code</span><input class="form-control" name="billingPostalCode" value={form?.billingPostalCode ?? billing.postalCode} /></label>
								<label><span>Country</span><input class="form-control" name="billingCountry" value={form?.billingCountry ?? billing.country} /></label>
							</div>
							<p class="hint">Saved locally, and synced to Salesforce Account{#if data.sfdcIds.accountId} (<code>{data.sfdcIds.accountId}</code>){/if}.</p>
							<div class="row-actions">
								<button class="btn btn-outline btn-sm" type="button" on:click={() => (editing = false)} disabled={saving}>Cancel</button>
								<button class="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
							</div>
						</form>
					{:else}
						<div class="fields">
							<div><span>Street</span><strong>{billing.street || '—'}</strong></div>
							<div><span>City</span><strong>{billing.city || '—'}</strong></div>
							<div><span>State / Province</span><strong>{billing.state || '—'}</strong></div>
							<div><span>Postal code</span><strong>{billing.postalCode || '—'}</strong></div>
							<div><span>Country</span><strong>{billing.country || '—'}</strong></div>
						</div>
					{/if}
				{:else if current.id === 'contact'}
					{#if !ct}
						<p class="empty">{data.contactError && !data.contactError.notFound ? `Could not load contact: ${data.contactError.message}` : "No Salesforce Contact linked yet. It'll appear here once the sync queue drains."}</p>
					{:else if editing}
						<form method="POST" action="?/edit_contact" use:enhance={() => {
							saving = true;
							return async ({ update }) => { await update(); saving = false; };
						}}>
							<div class="inputs">
								<label><span>First name</span><input class="form-control" name="firstName" value={form?.firstName ?? ct.FirstName ?? ''} /></label>
								<label><span>Last name *</span><input class="form-control" name="lastName" value={form?.lastName ?? ct.LastName ?? ''} required /></label>
								<label><span>Phone</span><input class="form-control" name="phone" type="tel" value={form?.phone ?? ct.Phone ?? ''} /></label>
							</div>
							<div class="row-actions">
								<button class="btn btn-outline btn-sm" type="button" on:click={() => (editing = false)} disabled={saving}>Cancel</button>
								<button class="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save to Salesforce'}</button>
							</div>
						</form>
					{:else}
						<div class="group-title">Contact Information</div>
						<div class="fields">
							<div><span>Salutation</span><strong>{ct.Salutation ?? '—'}</strong></div>
							<div><span>First Name</span><strong>{ct.FirstName ?? '—'}</strong></div>
							<div><span>Last Name</span><strong>{ct.LastName ?? '—'}</strong></div>
							<div><span>Title</span><strong>{ct.Title ?? '—'}</strong></div>
							<div><span>Department</span><strong>{ct.Department ?? '—'}</strong></div>
							<div><span>Email</span><strong>{ct.Email ?? '—'}</strong></div>
							<div><span>Phone</span><strong>{ct.Phone ?? '—'}</strong></div>
							<div><span>Mobile</span><strong>{ct.MobilePhone ?? '—'}</strong></div>
						</div>
						<div class="group-title">Mailing Address</div>
						<div class="fields">
							<div class="full"><span>Address</span><strong>{joinParts([ct.MailingStreet, ct.MailingCity, ct.MailingState, ct.MailingPostalCode, ct.MailingCountry])}</strong></div>
						</div>
					{/if}
				{:else if current.id === 'account'}
					{#if !acct}
						<div class="fields">
							<div><span>Account name</span><strong>{accountName}</strong></div>
							<div><span>Primary email</span><strong>{accEmail ?? '—'}</strong></div>
							<div class="full"><span>Website</span><strong>{#if accWebsite}<a href={href(accWebsite)} target="_blank" rel="noopener">{accWebsite}</a>{:else}—{/if}</strong></div>
						</div>
						<p class="hint">No Salesforce Account linked yet — showing what is saved in the app. More details appear here once it is linked.</p>
					{:else if editing && canManage}
						<form method="POST" action="?/edit_account_info" use:enhance={() => {
							saving = true;
							return async ({ update }) => { await update(); saving = false; };
						}}>
							<div class="inputs">
								<label class="full"><span>Account Name *</span><input class="form-control" name="accountName" required value={fv?.accountName ?? acct.Name ?? ''} /></label>
								<label><span>Phone</span><input class="form-control" name="accountPhone" type="tel" value={fv?.accountPhone ?? acct.Phone ?? ''} /></label>
								<label><span>Fax</span><input class="form-control" name="accountFax" value={fv?.accountFax ?? acct.Fax ?? ''} /></label>
								<label><span>Website</span><input class="form-control" name="accountWebsite" value={fv?.accountWebsite ?? acct.Website ?? ''} /></label>
								<label><span>Primary Email</span><input class="form-control" name="accountEmail" type="email" value={fv?.accountEmail ?? acct.Primary_Email__c ?? ''} /></label>
								<label><span>Industry</span><input class="form-control" name="accountIndustry" value={fv?.accountIndustry ?? acct.Industry ?? ''} /></label>
								<label><span>Employees</span><input class="form-control" name="accountEmployees" inputmode="numeric" value={fv?.accountEmployees ?? acct.NumberOfEmployees ?? ''} /></label>
								<label><span>Annual Revenue</span><input class="form-control" name="accountRevenue" inputmode="decimal" value={fv?.accountRevenue ?? acct.AnnualRevenue ?? ''} /></label>
							</div>
							<p class="hint">Saved to Salesforce Account. Account number, type, rating, ownership and start date are managed by Appeals Doctor.</p>
							<div class="row-actions">
								<button class="btn btn-outline btn-sm" type="button" on:click={() => (editing = false)} disabled={saving}>Cancel</button>
								<button class="btn btn-primary btn-sm" type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save to Salesforce'}</button>
							</div>
						</form>
					{:else}
						<div class="group-title">Account</div>
						<div class="fields">
							<div><span>Account name</span><strong>{accountName}</strong></div>
							<div><span>Primary email</span><strong>{#if accEmail}<a href={`mailto:${accEmail}`}>{accEmail}</a>{:else}—{/if}</strong></div>
							<div class="full"><span>Website</span><strong>{#if accWebsite}<a href={href(accWebsite)} target="_blank" rel="noopener">{accWebsite}</a>{:else}—{/if}</strong></div>
						</div>
						<div class="group-title">Details</div>
						<div class="fields">
							<div><span>Account Number</span><strong>{acct.AccountNumber ?? '—'}</strong></div>
							<div><span>Type</span><strong>{acct.Type ?? '—'}</strong></div>
							<div><span>Industry</span><strong>{acct.Industry ?? '—'}</strong></div>
							<div><span>Phone</span><strong>{acct.Phone ?? '—'}</strong></div>
							<div><span>Fax</span><strong>{acct.Fax ?? '—'}</strong></div>
							<div><span>Rating</span><strong>{acct.Rating ?? '—'}</strong></div>
							<div><span>Ownership</span><strong>{acct.Ownership ?? '—'}</strong></div>
							<div><span>Annual Revenue</span><strong>{fmtMoney(acct.AnnualRevenue)}</strong></div>
							<div><span>Employees</span><strong>{fmtNumber(acct.NumberOfEmployees)}</strong></div>
							<div><span>Start Date</span><strong>{fmtDate(acct.Start_Date__c)}</strong></div>
						</div>
						{#if acct.Description}<div class="group-title">Description</div><p class="prose">{acct.Description}</p>{/if}
					{/if}
				{:else if current.id === 'signin'}
					<div class="fields"><div><span>Google</span><strong>{data.googleLinked ? 'Connected' : 'Not connected'}</strong></div></div>
				{:else if current.id === 'system'}
					<div class="group-title">App user</div>
					<div class="fields">
						<div><span>App User ID</span><strong class="mono">{data.localUser.id}</strong></div>
						<div><span>Email</span><strong>{data.localUser.email}</strong></div>
						<div><span>Display Name</span><strong>{data.localUser.displayName ?? '—'}</strong></div>
						<div><span>Role</span><strong>{data.userRole ?? 'member'}</strong></div>
						<div><span>Member Since</span><strong>{fmtDate(data.localUser.createdAt)}</strong></div>
						<div><span>Last Login</span><strong>{fmtDateTime(data.localUser.lastLoginAt)}</strong></div>
					</div>
					<div class="group-title">Salesforce</div>
					<div class="fields">
						<div><span>Account ID</span>
							<strong>{#if data.sfdcIds.accountId}<button class="copy" type="button" title="Click to copy" on:click={() => copyId(data.sfdcIds.accountId)}>{data.sfdcIds.accountId}</button>{:else}Not linked{/if}</strong></div>
						<div><span>Contact ID</span>
							<strong>{#if data.sfdcIds.contactId}<button class="copy" type="button" title="Click to copy" on:click={() => copyId(data.sfdcIds.contactId)}>{data.sfdcIds.contactId}</button>{:else}Not linked{/if}</strong></div>
						{#if acct}
							<div><span>Owner ID</span><strong class="mono">{acct.OwnerId}</strong></div>
							<div><span>Created</span><strong>{fmtDateTime(acct.CreatedDate)}</strong></div>
							<div><span>Last Modified</span><strong>{fmtDateTime(acct.LastModifiedDate)}</strong></div>
						{/if}
					</div>
				{/if}
			</section>
		</div>
	</div>
{/if}

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 14px 26px 22px; }
	.muted { font-size: 11px; font-weight: 600; color: var(--grey-text); }
	.empty { font-size: 13px; color: var(--grey-text); padding: 14px; margin: 0; }
	.hint { font-size: 12px; color: var(--grey-text); margin: 10px 0 0; }

	.hero {
		background: white; border: 1px solid var(--grey-line); border-radius: 12px;
		padding: 20px 22px; display: flex; gap: 20px; align-items: center;
		justify-content: space-between; margin-bottom: 16px;
	}
	.hero-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
	.hero-title { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
	.hero-title h1 { margin: 0; font-size: 22px; font-weight: 800; color: var(--navy); }
	.hero-sub { font-size: 13px; color: var(--grey-text); }

	.plan-chip {
		flex: 0 0 auto; display: flex; align-items: center; gap: 14px;
		padding: 10px 14px 10px 16px; background: var(--bg, #F6F8FB);
		border: 1px solid var(--grey-line); border-radius: 10px; color: var(--navy); text-decoration: none; cursor: pointer; font: inherit; text-align: left;
	}
	.plan-chip:hover { border-color: var(--navy); background: white; }
	.plan-chip > div { display: flex; flex-direction: column; gap: 1px; }
	.plan-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); }
	.plan-price { font-size: 18px; font-weight: 800; line-height: 1.2; }
	.plan-price small { font-size: 12px; font-weight: 600; color: var(--grey-text); margin-left: 3px; }
	.plan-renews { font-size: 11px; color: var(--grey-text); }
	.plan-renews.ending { color: #b45309; font-weight: 700; }
	.chev { font-size: 16px; color: var(--grey-text); }

	.grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: stretch; }
	.card {
		background: white; border: 1px solid var(--grey-line); border-radius: 12px;
		display: flex; flex-direction: column; height: 560px; overflow: hidden; min-width: 0;
	}
	.card-head {
		padding: 14px 18px; border-bottom: 1px solid var(--grey-line); flex-shrink: 0;
		display: flex; align-items: center; justify-content: space-between; gap: 10px;
	}
	.card-head h2 { font-size: 14px; font-weight: 800; color: var(--navy); margin: 0; }
	.card-foot {
		padding: 10px 14px; border-top: 1px solid var(--grey-line); flex-shrink: 0;
		display: flex; align-items: center; justify-content: space-between; gap: 10px;
	}

	.rec-list { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
	.rec {
		display: flex; align-items: flex-start; gap: 12px; padding: 12px 14px; text-align: left;
		border-radius: 10px; border: 1px solid var(--grey-line); background: white; cursor: pointer;
		font: inherit; color: inherit; transition: border-color .2s;
	}
	.rec:hover { border-color: var(--orange); }
	.rec-icon {
		width: 36px; height: 36px; flex-shrink: 0; display: flex; align-items: center;
		justify-content: center; background: var(--navy-dark); border-radius: 9px;
	}
	.rec-icon img { width: 18px; height: 18px; object-fit: contain; }
	.rec-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
	.rec-name { font-weight: 700; color: var(--navy); font-size: 14px; }
	.rec-desc { font-size: 12px; color: var(--grey-text); word-break: break-word; }

	.search { padding: 10px 14px; border-bottom: 1px solid var(--grey-line); flex-shrink: 0; }
	.search input {
		width: 100%; border: 1.5px solid var(--grey-line); border-radius: 9px; padding: 8px 12px;
		font-size: 13px; outline: none; color: var(--navy); box-sizing: border-box;
	}
	.search input:focus { border-color: var(--orange); }
	.team-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0; }
	.member { display: flex; gap: 10px; align-items: flex-start; padding: 10px 14px; cursor: pointer; }
	.member:hover { background: #F6F8FB; }
	.avatar {
		width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; margin-top: 1px;
		display: flex; align-items: center; justify-content: center;
		font-size: 11px; font-weight: 700; color: white; background: var(--navy);
	}
	.member-body { flex: 1; min-width: 0; }
	.member-top { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
	.member-name { font-size: 14px; font-weight: 700; color: var(--navy); }
	.member-meta { font-size: 12px; color: var(--grey-text); margin-top: 1px; word-break: break-word; }
	.member-status { font-size: 11px; color: var(--grey-text); margin-top: 2px; }
	.role-tag {
		font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
		padding: 2px 7px; border-radius: 99px; background: #EEF2F8; color: var(--navy);
	}
	.poc-badge {
		font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 99px;
		background: rgba(245,161,0,.15); color: #B37400;
	}

	.backdrop {
		position: fixed; inset: 0; background: rgba(15,23,42,.55); z-index: 1000;
		display: flex; align-items: center; justify-content: center; padding: 24px;
	}
	.modal {
		background: white; border-radius: 12px; width: min(560px, 100%); max-height: 88vh;
		display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.25);
	}
	.modal > header, .modal form > header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--grey-line); }
	.modal h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy); }
	.modal-body { padding: 18px; overflow: auto; }
	.modal form { display: flex; flex-direction: column; min-height: 0; }
	footer { display: flex; justify-content: flex-end; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--grey-line); }
	.x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); line-height: 1; }
	.danger { color: #b91c1c; }

	.overlay { position: fixed; inset: 0; background: #F6F8FB; z-index: 900; display: flex; flex-direction: column; margin-left: 72px; }
	.overlay-head {
		display: flex; align-items: center; justify-content: space-between; gap: 12px;
		padding: 14px 26px; background: white; border-bottom: 1px solid var(--grey-line);
	}
	.overlay-head h2 { margin: 4px 0 0; font-size: 17px; font-weight: 800; color: var(--navy); }
	.crumbs { display: flex; gap: 6px; align-items: center; font-size: 12px; color: var(--grey-text); }
	.crumbs .link { background: none; border: none; padding: 0; font: inherit; color: inherit; cursor: pointer; }
	.crumbs .link:hover { text-decoration: underline; color: var(--navy); }
	.crumbs .cur { color: var(--navy); font-weight: 600; }
	.overlay-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 260px minmax(0, 1fr); gap: 20px; padding: 20px 26px; }
	aside { background: white; border: 1px solid var(--grey-line); border-radius: 12px; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; align-self: start; }
	.aside-head { display: flex; justify-content: space-between; font-size: 12px; font-weight: 700; color: var(--navy); padding: 2px 4px 6px; }
	.aside-item {
		display: flex; justify-content: space-between; gap: 8px; align-items: center; text-align: left;
		padding: 9px 10px; border-radius: 8px; border: 1px solid var(--grey-line); background: white;
		font: inherit; font-size: 13px; font-weight: 600; color: var(--navy); cursor: pointer;
	}
	.aside-item:hover { border-color: var(--orange); }
	.aside-item.active { border-color: var(--navy); background: #F6F8FB; }
	.panel { background: white; border: 1px solid var(--grey-line); border-radius: 12px; padding: 20px 22px; overflow-y: auto; min-width: 0; }
	.panel-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding-bottom: 12px; margin-bottom: 14px; border-bottom: 1px solid var(--grey-line); }
	.kind { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--grey-text); }
	.panel-name { font-size: 19px; font-weight: 800; color: var(--navy); }
	.panel-actions { display: flex; gap: 8px; align-items: center; }
	.group-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); margin: 16px 0 10px; }
	.group-title:first-of-type { margin-top: 0; }
	.prose { font-size: 14px; margin: 0; }

	.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 24px; }
	.fields > div { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
	.fields > .full { grid-column: 1 / -1; }
	.fields span, .inputs span { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--grey-text); }
	.fields strong { font-size: 14px; font-weight: 500; word-break: break-word; }
	.fields strong.mono, .copy { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
	.fields a { color: var(--orange); }
	.copy { background: none; border: none; padding: 0; cursor: pointer; color: var(--navy); text-align: left; }
	.copy:hover { text-decoration: underline; }
	.inputs { display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; }
	.inputs label { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
	.inputs .full { grid-column: 1 / -1; }
	.row-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

	@media (max-width: 960px) {
		.grid, .overlay-body { grid-template-columns: 1fr; }
		.hero { flex-direction: column; align-items: flex-start; }
	}
</style>
