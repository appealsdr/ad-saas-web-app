<script lang="ts">
	/**
	 * The full case workspace: hero, onboarding information, messages, required
	 * documents, revenue at risk and timeline. Rendered by the canonical case page
	 * (mode "full") and by the Cases split view (mode "split"). Its forms post named
	 * actions relative to the current route, which must expose createCaseActions().
	 * Hosts should key it by case id so no state carries over between cases.
	 */
	import { enhance } from '$app/forms';
	import CaseTimeline from '$components/cases/CaseTimeline.svelte';
	import NotifyTechnicianDialog from '$components/cases/NotifyTechnicianDialog.svelte';
	import NotifyTechnicianHelp from '$components/cases/NotifyTechnicianHelp.svelte';
	import ConversationPanel from '$components/messages/ConversationPanel.svelte';
	import RequiredFiles from '$components/files/RequiredFiles.svelte';
	import { isWaitingOnClient } from '$lib/cases/case-list';
	import { refreshAfterCaseMutation } from '$lib/cases/refresh-client';
	import type { CaseWorkspaceData } from '$lib/server/cases/case-workspace';
	import type { CaseActionForm } from '$lib/types/case-workspace';

	export let data: CaseWorkspaceData;
	export let form: CaseActionForm = null;
	export let mode: 'full' | 'split' = 'full';
	/** Split view only: the canonical store-scoped URL of this case. */
	export let canonicalHref = '';
	/** Split view only: where "Back to cases" goes on narrow screens. */
	export let backHref: string | null = null;
	/** Runs after a successful change, before its result is shown. */
	export let onMutated: () => Promise<unknown> = refreshAfterCaseMutation;

	// ── Onboarding information (Case.Case_Onboarding__c config) ──
	let editingOnboarding = false;
	let savingOnboarding = false;
	$: onboarding = data.onboarding;
	// First-time fill-in opens straight into edit mode; afterwards the user clicks Edit.
	let onboardingInit = false;
	$: if (onboarding && !onboardingInit) {
		onboardingInit = true;
		editingOnboarding = !onboarding.provided;
	}
	$: onboardingErrors = form?.onboardingFieldErrors ?? {};
	function showValue(v: string | number | boolean | null, type: string): string {
		if (type === 'checkbox') return v ? 'Yes' : 'No';
		return v === null || v === '' ? '—' : String(v);
	}
	// ── Status → mockup badge classes ──
	const STATUS_BADGE: Record<string, string> = {
		'new': 'badge-orange',
		'open': 'badge-orange',
		'working': 'badge-blue',
		'in progress': 'badge-blue',
		'in progress - tech': 'badge-blue',
		'waiting on client': 'badge-red',
		'waiting': 'badge-red',
		'pending': 'badge-red',
		'closed': 'badge-green',
		'resolved': 'badge-green'
	};
	function badgeClass(status: string): string {
		return STATUS_BADGE[status.toLowerCase()] ?? 'badge-grey';
	}
	// ── "Notify technician" ──
	$: waitingOnClient = data.case.Status.trim().toLowerCase() === 'waiting on client';
	$: canNotify = data.clientTodo?.length === 0;
	let notifyOpen = false;
	let notified: string | null = null;
	let handledForm: CaseActionForm = null;
	// Offered once for each client action that leaves nothing outstanding.
	$: onForm(form);
	function onForm(next: CaseActionForm) {
		if (next === handledForm) return;
		handledForm = next;
		if (next?.promptNotify) openNotify();
	}
	function openNotify() {
		notified = null;
		notifyOpen = true;
	}
	// ── Formatters ──
	function fmtDate(iso: string | null | undefined) {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
		catch { return iso; }
	}

	// ── Estimated Revenue at Risk — Case.Estimated_Revenue_at_Risk__c ──
	$: revenueAtRisk = data.case.estimatedRevenueAtRisk ?? 0;

	// ── Required-file rollup ──
	$: uploadedFiles = data.requiredFiles.filter((f) => f.uploaded);
	$: pendingFiles  = data.requiredFiles.filter((f) => !f.uploaded);
	$: onboardingPending = !!onboarding && !onboarding.provided;
	$: stepsTotal = data.requiredFiles.length + (onboarding ? 1 : 0);
	$: stepsDone = uploadedFiles.length + (onboarding?.provided ? 1 : 0);
</script>

<div class="content-area" class:split={mode === 'split'}>
	{#if mode === 'split'}
		<div class="split-head">
			{#if backHref}
				<a class="btn btn-outline btn-sm back-link" href={backHref}>← Back to cases</a>
			{/if}
			<div class="split-title">
				<h2>{data.case.CaseNumber}</h2>
				<div>{data.case.recordTypeName ?? 'Case'} · {data.storeName}</div>
			</div>
			<a class="btn btn-outline btn-sm" href={canonicalHref}>Open full page</a>
		</div>
	{/if}

	{#if notified}<div class="alert alert-success" role="status" style="margin-bottom:14px">{notified}</div>{/if}
	{#if form?.revenueRiskSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.revenueRiskSuccess}</div>{/if}
	{#if form?.revenueRiskError}<div class="alert alert-error" style="margin-bottom:14px">{form.revenueRiskError}</div>{/if}
	{#if form?.uploadSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.uploadSuccess}</div>{/if}
	{#if form?.uploadError}<div class="alert alert-error" style="margin-bottom:14px">{form.uploadError}</div>{/if}

	<section class="hero">
		<div class="hero-main">
			<div class="hero-title-row">
				<h1 class="hero-title">{data.case.Subject ?? data.case.recordTypeName ?? data.case.CaseNumber}</h1>
				<span class={`badge ${badgeClass(data.case.Status)}`}>{data.case.Status}</span>
				{#if waitingOnClient}
					<span class="notify">
						<button type="button" class="btn btn-primary btn-sm" data-mutates disabled={!canNotify} on:click={openNotify}>Notify technician</button>
						<NotifyTechnicianHelp todo={data.clientTodo} />
					</span>
				{/if}
			</div>
			<div class="hero-meta">
				{#if data.case.asin}
					<span>ASIN</span>
					<span class="asin-chip">{data.case.asin}</span>
				{/if}
				<span>
					{data.storeMarketplaces?.split(';').join(', ') ?? '—'} · Opened {fmtDate(data.case.CreatedDate)} · Priority {data.case.Priority ?? '—'}
				</span>
			</div>
			<div class="hero-progress">
				<div class="progress-segs">
					{#if onboarding}
						<span class="progress-seg" class:done={onboarding.provided} title="Onboarding information"></span>
					{/if}
					{#each data.requiredFiles as f (f.id)}
						<span class="progress-seg" class:done={f.uploaded} title={f.name}></span>
					{/each}
				</div>
				<span class="hero-meta">{stepsDone} of {stepsTotal} steps done</span>
			</div>
			{#if onboardingPending || pendingFiles.length > 0}
				<ul class="hero-todo">
					{#if onboardingPending}
						<li>Onboarding information not provided yet</li>
					{/if}
					{#each pendingFiles as f (f.id)}
						<li>Not uploaded: {f.name}</li>
					{/each}
				</ul>
			{/if}
				{#if isWaitingOnClient(data.case.Status) && pendingFiles.length > 0}
				<div class="alert alert-warn" style="margin:0">
					⚠️ Action required: Please upload the requested documents to proceed.
				</div>
			{/if}
		</div>
		<div class="rev-box">
			<div class="rev-label">Estimated Revenue at Risk</div>
			<div class="rev-amount">${revenueAtRisk.toLocaleString()}</div>
		</div>
		<!-- ── Onboarding information (only when the case has an onboarding config) ── -->
			{#if onboarding}
				<div class="onb-card">
					<div class="card-title">
						Onboarding information
						{#if onboarding.provided}
							<span class="onb-state done">✓ Provided</span>
						{:else}
							<span class="onb-state todo">Needs your input</span>
						{/if}
					</div>

					{#if form?.onboardingError}
						<div class="alert alert-error" style="margin-bottom:10px">{form.onboardingError}</div>
					{/if}
					{#if form?.onboardingSuccess}
						<div class="alert alert-success" style="margin-bottom:10px">{form.onboardingSuccess}</div>
					{/if}

					{#if editingOnboarding}
						<form
							method="POST"
							action="?/save_onboarding"
							use:enhance={() => {
								savingOnboarding = true;
								return async ({ update, result }) => {
									if (result.type === 'success') await onMutated();
									await update({ reset: false, invalidateAll: false });
									savingOnboarding = false;
									if (result.type === 'success') editingOnboarding = false;
								};
							}}
						>
							<div class="onb-fields">
								{#each onboarding.fields as f (f.apiName)}
									<label class="onb-field" class:err={onboardingErrors[f.apiName]}>
										<span class="onb-label">{f.label}{#if f.required} <b class="req">*</b>{/if}</span>
										{#if f.type === 'checkbox'}
											<input type="checkbox" name={f.apiName} checked={f.value === true} />
										{:else if f.type === 'picklist'}
											<select class="form-control" name={f.apiName}>
												<option value="">—</option>
												{#each f.options as o}
													<option value={o} selected={f.value === o}>{o}</option>
												{/each}
											</select>
										{:else if f.type === 'textarea'}
											<textarea class="form-control" name={f.apiName} rows="3">{f.value ?? ''}</textarea>
										{:else}
											<input
												class="form-control"
												name={f.apiName}
												type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
												step={f.type === 'number' ? 'any' : undefined}
												value={f.value ?? ''}
											/>
										{/if}
										{#if onboardingErrors[f.apiName]}
											<span class="onb-err">{onboardingErrors[f.apiName]}</span>
										{/if}
									</label>
								{/each}
							</div>
							<div class="onb-actions">
								<button type="submit" class="btn btn-primary btn-sm" data-mutates disabled={savingOnboarding}>
									{savingOnboarding ? 'Saving…' : 'Save'}
								</button>
								{#if onboarding.provided}
									<button type="button" class="btn btn-outline btn-sm" on:click={() => (editingOnboarding = false)}>Cancel</button>
								{/if}
							</div>
						</form>
					{:else}
						<dl class="onb-view">
							{#each onboarding.fields as f (f.apiName)}
								<div>
									<dt>{f.label}</dt>
									<dd>{showValue(f.value, f.type)}</dd>
								</div>
							{/each}
						</dl>
						<div class="onb-actions">
							<button type="button" class="btn btn-outline btn-sm" data-mutates on:click={() => (editingOnboarding = true)}>Edit</button>
						</div>
					{/if}
				</div>
			{/if}
	</section>

	<div class="case-detail-grid">
		<div class="grid-col">
			<!-- ── Messages card (shared conversation component, Case context) ── -->
			<ConversationPanel
				conversation={data.conversation}
				title="Messages"
				scopeSubtitle={`Case ${data.case.CaseNumber}`}
				postAction="?/post_message"
				readAction="?/mark_read"
				idPrefix="case-msg"
				onRefresh={onMutated}
			/>
		</div>

		<!-- ═══════════════════ RIGHT COLUMN ═══════════════════ -->
		<div class="grid-col">
			<!-- ── Case Documents card (required-file checklist) ── -->
			<div class="card docs-card">
				<div class="card-title">
					Case Documents
					<span style="font-size:11px;font-weight:500;color:var(--grey-text)">
						{uploadedFiles.length} of {data.requiredFiles.length} uploaded
					</span>
				</div>

				{#if data.filesError}
					<div class="alert alert-error" style="margin-bottom:10px">
						Could not load required files: {data.filesError}
					</div>
				{:else}
					<RequiredFiles
						files={data.requiredFiles}
						uploadAction="?/upload_doc"
						clearAction="?/clear_doc"
						multiple
						previewLimit={2}
						contextLabel={`Case ${data.case.CaseNumber}`}
						buildDownloadUrl={(docId) => `/api/cases/${data.case.Id}/documents/${docId}`}
						uploadError={form?.uploadError ?? null}
						refresh={onMutated}
					/>
				{/if}
			</div>
		</div>
	</div>

	<CaseTimeline events={data.timeline} historyError={data.historyError} />
</div>

{#if notifyOpen}
	<NotifyTechnicianDialog
		action="?/notify_technician"
		onClose={() => (notifyOpen = false)}
		onNotified={(message) => (notified = message)}
		onRefresh={onMutated}
	/>
{/if}

<style>
	/* Color tokens — defaults match the mockup; override at root if your
	   global stylesheet defines different palette variables. */
	:global(:root) {
		--orange-dk: #c47a00;
	}

	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }

	/* Split view: the pane scrolls, and it is narrower than the window, so stack the
	   two columns unless the screen is very wide. */
	.content-area.split { flex: none; overflow: visible; padding: 16px 18px; }
	.split .case-detail-grid { grid-template-columns: minmax(0, 1fr); }
	@media (min-width: 1700px) { .split .case-detail-grid { grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr); } }
	.split-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 12px; }
	.split-title { flex: 1 1 200px; min-width: 0; }
	.split-title h2 { margin: 0; font-size: 15px; font-weight: 700; color: var(--navy); }
	.split-title div { font-size: 12px; color: var(--grey-text); overflow-wrap: anywhere; }
	.back-link { display: none; }
	@media (max-width: 900px) {
		.back-link { display: inline-flex; }
		.split-title { order: 3; flex-basis: 100%; }
	}

	/* ── Two-column grid (from mockup) ───────────────────────── */
	.case-detail-grid {
		display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(320px, 1fr);
		gap: 20px; align-items: stretch; margin-bottom: 20px;
	}
	.grid-col { min-width: 0; }
	@media (max-width: 900px) { .case-detail-grid { grid-template-columns: 1fr; } }

	/* ── Breadcrumb + hero (Case Detail reference) ───────────── */
	.hero {
		background: white; border: 1px solid var(--grey-line); border-radius: var(--radius);
		padding: 20px 22px; display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start;
		justify-content: space-between; margin-bottom: 16px;
	}
	.hero-main { display: flex; flex-direction: column; gap: 10px; flex: 1 1 0; min-width: 0; }
	.hero-title-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
	.notify { display: inline-flex; align-items: center; gap: 6px; }
	.hero-title { margin: 0; font-size: 21px; line-height: 1.3; font-weight: 700; color: var(--navy); text-wrap: pretty; }
	.hero-meta {
		display: flex; flex-wrap: wrap; gap: 8px; align-items: center;
		font-size: 13px; color: var(--grey-text);
	}
	.asin-chip {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
		background: var(--grey-bg); border: 1px solid var(--grey-line);
		padding: 2px 8px; border-radius: 6px; color: var(--navy);
	}
	.hero-progress { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
	.progress-segs { display: flex; gap: 4px; }
	.progress-seg { width: 34px; height: 6px; border-radius: 3px; background: var(--grey-line); }
	.progress-seg.done { background: var(--green); }
	.hero-todo { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font-size: 12px; color: #b45309; }
	.hero-todo li::before { content: '• '; }
	.rev-box {
		background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
		border-radius: 10px; padding: 10px 16px; color: white;
		flex: 0 0 auto; margin-left: auto; text-align: right; align-self: flex-start;
	}
	/* Narrow detail pane: let the revenue box wrap under the title instead of covering it. */
	.split .hero-main { flex-basis: 260px; }
	.rev-label { font-size: 11px; color: rgba(255,255,255,.55); }
	.rev-amount { font-size: 20px; font-weight: 800; color: var(--orange); line-height: 1.2; }
	.docs-card { height: 560px; display: flex; flex-direction: column; overflow: hidden; margin-bottom: 0; }
	.docs-card :global(.required-files), .docs-card > :global(:last-child) { min-height: 0; overflow-y: auto; }

	/* Onboarding information */
	.onb-card { flex: 0 0 100%; width: 100%; margin-top: 2px; padding-top: 14px; border-top: 1px solid var(--grey-line); }
	.onb-card .card-title { border-bottom: 0; padding-bottom: 0; margin-bottom: 12px; }
	@media (min-width: 720px) { .onb-fields { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px 20px; } .onb-view { grid-template-columns: 1fr 1fr; gap: 12px 20px; } }
	.onb-state { font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 999px; }
	.onb-state.done { color: var(--green); background: #DCFCE7; }
	.onb-state.todo { color: #92400e; background: #FEF3C7; }
	.onb-fields { display: grid; gap: 12px; align-items: end; }
	.onb-field { display: grid; gap: 4px; font-size: 13px; }
	.onb-label { font-weight: 600; color: var(--navy); }
	.onb-label .req { color: #b91c1c; }
	.onb-field.err :global(.form-control) { border-color: #b91c1c; }
	.onb-err { color: #b91c1c; font-size: 12px; }
	.onb-actions { display: flex; gap: 8px; margin-top: 14px; }
	.onb-view { display: grid; gap: 10px; margin: 0; }
	.onb-view dt { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--grey-text); }
	.onb-view dd { margin: 2px 0 0; font-size: 14px; color: var(--navy); word-break: break-word; }

	.card {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 18px 20px;
	}
	.card-title {
		display: flex; align-items: center; gap: 10px; justify-content: space-between;
		font-size: 14px; font-weight: 700; color: var(--navy);
		margin-bottom: 14px; padding-bottom: 10px;
		border-bottom: 1px solid var(--grey-line);
	}

	/* ── Badges (mockup-style) ───────────────────────────────── */
	.badge {
		display: inline-block; padding: 3px 10px;
		font-size: 11px; font-weight: 700; border-radius: 12px;
	}
	.badge-orange { background: #fff1de; color: #b45309; }
	.badge-blue   { background: #dbeafe; color: #1d4ed8; }
	.badge-yellow { background: #fef3c7; color: #92400e; }
	.badge-green  { background: #d1fae5; color: #047857; }
	.badge-grey   { background: #e5e7eb; color: #374151; }
	/* ── Buttons (mockup small variants) ─────────────────────── */
	.btn-sm {
		padding: 5px 12px; font-size: 12px; font-weight: 600;
		border-radius: 7px; border: 1px solid transparent; cursor: pointer;
	}
	/* ── Alerts (mockup) ─────────────────────────────────────── */
	.alert {
		border-radius: 9px; padding: 12px 16px; font-size: 13px;
	}
	.alert-info { background: #dbeafe; border: 1px solid #93c5fd; color: #1e40af; }
	.alert-warn { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; }
	.alert-success { background: #d1fae5; border: 1px solid #86efac; color: #166534; }
	.alert-error { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; }

</style>
