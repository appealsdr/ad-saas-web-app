<script lang="ts">
	import { page } from '$app/stores';
	import RecordDetail from '$lib/components/admin/RecordDetail.svelte';
	import RecordModal from '$lib/components/admin/RecordModal.svelte';
	import FilePreviewModal from '$lib/components/files/FilePreviewModal.svelte';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;

	$: r = data.record;
	$: accountId = $page.params.accountId;
	$: list = r.kind === 'user' ? 'users' : r.kind === 'store' ? 'stores' : 'billing/contracts';
	$: msg = form && 'ok' in form && typeof form.ok === 'string' ? form.ok : null;
	$: err = form && 'error' in form && form.error ? String(form.error) : null;
	$: s = data.store;
	$: c = data.contract;

	const money = (n: number) => '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	const fmtD = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
	const size = (b: string) => (Number(b) > 1048576 ? (Number(b) / 1048576).toFixed(1) + ' MB' : Math.ceil(Number(b) / 1024) + ' KB');
	const PAY = { paid: ['Paid', '#DCFCE7', '#15803d'], due: ['Due', '#FEF3C7', '#92400e'], failed: ['Failed', '#FEE2E2', '#b91c1c'], closed: ['Closed', '#F1F5F9', '#475569'], inactive: ['Not Active', '#F1F5F9', '#475569'], ready: ['Ready to pay', '#DBEAFE', '#1d4ed8'] } as const;
	const caseChip = (st: string): [string, string] => (/closed|resolved/i.test(st) ? ['#DCFCE7', '#15803d'] : /waiting|pending|awaiting/i.test(st) ? ['#FEE2E2', '#b91c1c'] : /progress|working/i.test(st) ? ['#DBEAFE', '#1d4ed8'] : ['#FFEDD5', '#c2410c']);

	let pwModal: 'reset' | 'temp' | null = null;
	$: canReset = data.canManageUsers && data.userActive && !data.userIsStaff;
	$: temp = form && 'tempPassword' in form ? String(form.tempPassword) : null;
	let previewOpen = false;
	let pv = { name: '', mime: null as string | null, url: '', dl: '' };
	function preview(d: NonNullable<typeof s>['docs'][number]) {
		const u = `/admin/accounts/${accountId}/documents/${d.kind}/${d.id}/download`;
		pv = { name: d.original_name, mime: d.mime_type, url: `${u}?disposition=inline`, dl: u };
		previewOpen = true;
	}
</script>

<svelte:head><title>{r.title} — Admin</title></svelte:head>

{#if temp}
	<div class="adm-alert warn" role="alert">
		One-time temporary password (shown only once — copy it now and share it securely):
		<strong class="adm-mono" style="user-select:all">{temp}</strong>
	</div>
{/if}

<RecordDetail
	title={r.title} kindLabel={r.kind === 'user' ? 'User' : r.kind === 'store' ? 'Store' : 'Service contract'}
	recordId={r.id} syncKind={r.kind} groups={data.groups}
	sfObject={data.sfObject} sfId={r.sfdcId} sfState={data.sfState} sfUrl={data.sfUrl}
	canEdit={data.canEdit} canSync={data.canSync} canDelete={data.canDelete}
	deleteConfirm={r.deleteConfirm} startEditing={data.startEditing}
	message={msg} error={err} backHref="/admin/accounts/{accountId}/{list}" backLabel={r.kind === 'contract' ? 'Back to contracts' : r.kind === 'user' ? 'Back to users' : 'Back to stores'}>
	<svelte:fragment slot="links">
		{#if r.kind === 'user'}
			<button type="button" class="adm-btn outline" disabled={!canReset} title={data.userIsStaff ? 'Managed under Staff' : !data.userActive ? 'User is suspended' : data.canManageUsers ? 'Email the user a link to choose a new password' : 'Your role cannot manage users'} on:click={() => (pwModal = 'reset')}>✉ Reset password (email link)</button>
			<button type="button" class="adm-btn outline" disabled={!canReset} title="Set a one-time temporary password" on:click={() => (pwModal = 'temp')}>🔑 Reset password (temporary)</button>
		{/if}
		{#if c?.stripePiUrl}<a class="adm-btn outline" href={c.stripePiUrl} target="_blank" rel="noopener">View in Stripe ↗</a>
		{:else if c?.stripeSubUrl}<a class="adm-btn outline" href={c.stripeSubUrl} target="_blank" rel="noopener">View in Stripe ↗</a>{/if}
	</svelte:fragment>

	{#if c}
		<div class="adm-card">
			<h2>Contract line items <span class="cnt">{c.lines.length}</span></h2>
			{#if c.lines.length === 0}<div class="adm-empty">No line items.</div>{:else}
				<div class="adm-table-wrap"><table class="adm-table">
					<caption class="adm-sr">Contract line items</caption>
					<thead><tr><th scope="col">Service</th><th scope="col">Category</th><th scope="col">Qty</th><th scope="col">Unit price</th><th scope="col">Subtotal</th><th scope="col">Salesforce line</th></tr></thead>
					<tbody>
						{#each c.lines as l}
							<tr><td><strong>{l.name}</strong>{#if l.description}<div class="adm-muted">{l.description}</div>{/if}</td><td>{l.category ?? '—'}</td><td>{l.qty}</td><td>{money(l.unit)}</td><td>{money(l.qty * l.unit)}</td><td class="adm-mono adm-muted">{l.sfdcLineId ?? '—'}</td></tr>
						{/each}
						<tr><td colspan="4"><strong>Contract total</strong></td><td colspan="2"><strong>{money(c.lines.reduce((n, l) => n + l.qty * l.unit, 0) || c.amount)}</strong></td></tr>
					</tbody>
				</table></div>
			{/if}
		</div>
		<div class="adm-card">
			<h2>Payments <span class="cnt">{c.payments.length}</span></h2>
			<div class="adm-table-wrap"><table class="adm-table">
				<caption class="adm-sr">Payments</caption>
				<thead><tr><th scope="col">Payment</th><th scope="col">Type</th><th scope="col">Amount</th><th scope="col">Status</th><th scope="col">Date</th><th scope="col">Links</th></tr></thead>
				<tbody>
					{#each c.payments as p (p.key)}
						{@const st = PAY[p.status]}
						<tr class:sub={p.isLine}>
							<td><a href="/admin/accounts/{accountId}/billing/payments/{encodeURIComponent(p.key)}">{p.name}</a></td>
							<td>{p.kind}</td><td><strong>{money(p.amount)}</strong></td>
							<td><span class="chip" style="background:{st[1]};color:{st[2]}">{st[0]}</span></td>
							<td>{fmtD(p.date)}</td>
							<td>
								{#if p.sfUrl}<a href={p.sfUrl} target="_blank" rel="noopener">Salesforce ↗</a>{/if}
								{#if p.stripeUrl}{p.sfUrl ? ' · ' : ''}<a href={p.stripeUrl} target="_blank" rel="noopener">Stripe ↗</a>{/if}
								{#if !p.sfUrl && !p.stripeUrl}<span class="adm-muted">—</span>{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table></div>
		</div>
	{/if}

	{#if s}
		<div class="adm-card">
			<h2>Cases <span class="cnt">{s.cases.length}</span></h2>
			{#if s.casesError}<div class="adm-alert error">Could not load cases from Salesforce: {s.casesError}</div>{/if}
			{#if s.cases.length === 0}<div class="adm-empty">{r.sfdcId ? 'No cases for this store.' : 'This store is not linked to Salesforce, so cases cannot be loaded.'}</div>{:else}
				<div class="adm-table-wrap"><table class="adm-table">
					<caption class="adm-sr">Cases</caption>
					<thead><tr><th scope="col">Case</th><th scope="col">Service</th><th scope="col">Status</th><th scope="col">Priority</th><th scope="col">Opened</th><th scope="col">Updated</th></tr></thead>
					<tbody>
						{#each s.cases as k (k.id)}
							{@const ch = caseChip(k.status)}
							<tr><td><a class="adm-mono" href="/admin/accounts/{accountId}/cases/{k.id}">{k.number}</a></td><td>{k.service}</td><td><span class="chip" style="background:{ch[0]};color:{ch[1]}">{k.status}</span></td><td>{k.priority ?? '—'}</td><td>{fmtD(k.opened)}</td><td>{fmtD(k.modified)}</td></tr>
						{/each}
					</tbody>
				</table></div>
			{/if}
		</div>
		<div class="adm-card">
			<h2>Documents <span class="cnt">{s.docs.length}</span></h2>
			{#if s.docs.length === 0}<div class="adm-empty">No documents uploaded for this store.</div>{:else}
				<div class="adm-table-wrap"><table class="adm-table">
					<caption class="adm-sr">Store documents</caption>
					<thead><tr><th scope="col">File</th><th scope="col">Type</th><th scope="col">Size</th><th scope="col">Uploaded</th><th scope="col">Actions</th></tr></thead>
					<tbody>
						{#each s.docs as d (d.kind + d.id)}
							<tr><td>{d.original_name}</td><td>{d.kind === 'case' ? `Case ${d.sfdc_case_id ?? ''}` : 'Store document'}</td><td>{size(d.size_bytes)}</td><td>{fmtD(d.created_at)}</td>
								<td><button type="button" class="adm-btn sm" on:click={() => preview(d)}>Preview</button> <a class="adm-btn sm outline" href="/admin/accounts/{accountId}/documents/{d.kind}/{d.id}/download" data-sveltekit-reload>Download</a></td></tr>
						{/each}
					</tbody>
				</table></div>
			{/if}
		</div>
	{/if}
</RecordDetail>

{#if pwModal}
	<RecordModal kind="confirm" title={pwModal === 'reset' ? 'Reset password by email link' : 'Reset password with a temporary password'}
		body={pwModal === 'reset'
			? 'Emails this user a link (valid 1 hour) to choose a new password. After they set it, they get a confirmation email.'
			: 'Generates a one-time password, shown to you once, signs the user out everywhere and forces a new password at next sign-in. They are emailed a notification (without the password).'}
		recordName={r.title} recordId={String(r.raw.email ?? r.id)} action={pwModal === 'reset' ? '?/reset' : '?/temp'}
		confirmText={String(r.raw.email ?? '')} submitLabel={pwModal === 'reset' ? 'Send reset email' : 'Set temporary password'} on:close={() => (pwModal = null)} />
{/if}

<FilePreviewModal bind:open={previewOpen} fileName={pv.name} mimeType={pv.mime} previewUrl={pv.url} downloadUrl={pv.dl} />

<style>
	.cnt { font-size: 11px; background: #EEF2F8; border-radius: 99px; padding: 1px 8px; margin-left: 6px; font-weight: 700; }
	.chip { display: inline-block; padding: 2px 9px; border-radius: 12px; font-size: 11px; font-weight: 700; white-space: nowrap; }
	tr.sub td { background: #fafafa; }
</style>
