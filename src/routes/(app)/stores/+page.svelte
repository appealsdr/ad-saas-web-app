<script lang="ts">
	import { enhance } from '$app/forms';
	import Topbar from '$components/layout/Topbar.svelte';
	import Badge from '$lib/components/ui/Badge.svelte';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	let showCreate = false;
	let saving = false;

	$: if (form?.error) showCreate = true; // reopen modal on validation error

	function statusVariant(s: string): 'green' | 'orange' | 'grey' {
		if (s === 'connected') return 'green';
		if (s === 'error') return 'orange';
		return 'grey';
	}
	function statusLabel(s: string): string {
		if (s === 'connected') return 'All set up';
		if (s === 'error') return 'Needs reconnecting';
		return 'Setup unfinished';
	}

	$: erroredStores = data.stores.filter((s) => s.spapiStatus === 'error');

	function fmtDate(iso: string | null) {
		if (!iso) return '—';
		try {
			return new Date(iso).toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
		} catch {
			return iso;
		}
	}

	function setupStepsDone(s: (typeof data.stores)[number]) {
		return [s.setup.storeAdded, s.setup.contactSet, s.setup.amazonConnected, s.setup.planChosen].filter(Boolean)
			.length;
	}

	let query = '';
	$: filteredStores = data.stores.filter((s) => {
		if (!query.trim()) return true;
		const q = query.toLowerCase();
		return s.name.toLowerCase().includes(q) || (s.sellerId ?? '').toLowerCase().includes(q);
	});
</script>

<svelte:head><title>Stores — Appeals Doctor</title></svelte:head>

<Topbar title="Stores" subtitle="Amazon seller accounts">
	<button class="btn btn-primary btn-sm" data-mutates on:click={() => (showCreate = true)}>+ Add Store</button>
</Topbar>

<div class="content-area">
	{#if data.stores.length === 0}
		<!-- 2b: empty state — 3 steps, no jargon -->
		<div class="empty-onboard">
			<h2>Let's add your first Amazon store</h2>
			<p class="empty-sub">
				A "store" is one Amazon seller account. Once it's added we watch it for policy warnings,
				suspensions and listing takedowns — and tell you what to do about them.
			</p>
			<ol class="steps">
				<li>
					<span class="step-num">1</span>
					<div>
						<div class="step-title">Tell us the basics</div>
						<div class="step-body">Give it a name — Amazon fills in the marketplace and Seller ID once you connect.</div>
					</div>
				</li>
				<li>
					<span class="step-num">2</span>
					<div>
						<div class="step-title">Connect it to Amazon</div>
						<div class="step-body">You'll sign in at Amazon and approve read-only access. We never post, price or message buyers for you.</div>
					</div>
				</li>
				<li>
					<span class="step-num">3</span>
					<div>
						<div class="step-title">Pick how we help</div>
						<div class="step-body">A monthly plan for ongoing cover, or a single service if you have one problem to fix right now.</div>
					</div>
				</li>
			</ol>
			<button class="btn btn-primary btn-lg" on:click={() => (showCreate = true)}>
				Add my first store
			</button>
			<div class="empty-hint">Nothing to pay yet</div>
		</div>
	{:else}
		<!-- 2a: stores list — health-first -->
		{#if erroredStores.length > 0}
			<div class="health-banner">
				<span class="warn-icon" aria-hidden="true">⚠</span>
				<div class="health-banner-text">
					<strong>{erroredStores[0].name}</strong> lost its Amazon connection.
					We can't watch for new violations there until you reconnect — it takes about a minute.
				</div>
				<a class="btn btn-primary btn-sm" href={`/stores/${erroredStores[0].id}?step=connect`}>
					Reconnect now
				</a>
			</div>
		{/if}

		<div class="toolbar">
			<div class="search-wrap">
				<input
					type="search"
					class="form-control"
					placeholder="Search by store name or Seller ID…"
					bind:value={query}
				/>
			</div>
			<span class="count">{filteredStores.length} of {data.stores.length} stores</span>
		</div>

		{#if filteredStores.length === 0}
			<div class="no-match">No stores match "{query}". Try a different name or Seller ID.</div>
		{/if}

		<div class="store-list">
			{#each filteredStores as s}
				<div class="store-row" class:attention={s.spapiStatus === 'error'}>
					<div class="store-row-main">
						<div class="store-row-hdr">
							<a class="store-name" href={`/stores/${s.id}`}>{s.name}</a>
							<Badge variant={statusVariant(s.spapiStatus)}>{statusLabel(s.spapiStatus)}</Badge>
						</div>
						<div class="store-meta">
							{#if s.marketplaces}{s.marketplaces.split(';').join(' · ')}{:else}No marketplaces yet{/if}
							{#if s.sellerId}· Seller ID {s.sellerId}{/if}
							{#if s.country}· {s.country}{/if}
						</div>

						{#if s.spapiStatus !== 'connected' || !s.plan}
							<div class="setup-steps">
								<span class="setup-count">{setupStepsDone(s)} of 4 steps done</span>
								<span class="setup-step" class:done={s.setup.storeAdded}>{s.setup.storeAdded ? '✓' : '1'} Store added</span>
								<span class="setup-step" class:done={s.setup.contactSet}>{s.setup.contactSet ? '✓' : '2'} Contact set</span>
								<span class="setup-step" class:done={s.setup.amazonConnected}>{s.setup.amazonConnected ? '✓' : '3'} Connect Amazon</span>
								<span class="setup-step" class:done={s.setup.planChosen}>{s.setup.planChosen ? '✓' : '4'} Choose a plan</span>
							</div>
						{:else}
							<div class="stat-row">
								<div>
									<div class="stat-lbl">Open issues</div>
									<div class="stat-val">{s.openIssues}</div>
								</div>
								<div>
									<div class="stat-lbl">Your plan</div>
									<div class="stat-val">{s.plan.name}</div>
									<div class="stat-sub">{s.plan.cancelling ? 'ends' : 'renews'} {fmtDate(s.plan.endDate)}</div>
								</div>
								<div>
									<div class="stat-lbl">Documents</div>
									<div class="stat-val">{s.documents.uploaded} / {s.documents.total}</div>
									{#if s.documents.uploaded < s.documents.total}
										<div class="stat-sub">{s.documents.total - s.documents.uploaded} still missing</div>
									{:else}
										<div class="stat-sub">nothing missing</div>
									{/if}
								</div>
							</div>
						{/if}
					</div>

					<div class="store-row-side">
						{#if s.spapiStatus === 'error'}
							<div class="side-msg">Amazon stopped accepting our connection.</div>
							<a class="btn btn-primary btn-sm" href={`/stores/${s.id}?step=connect`}>Reconnect with Amazon →</a>
						{:else if s.spapiStatus !== 'connected' || !s.plan}
							<div class="side-msg">
								{#if !s.setup.contactSet}Next step: add a point of contact.
								{:else if !s.setup.amazonConnected}Next step: let us read this store's performance notices from Amazon.
								{:else}Next step: choose a plan to unlock monitoring.{/if}
							</div>
							<a class="btn btn-primary btn-sm" href={`/stores/${s.id}?step=connect`}>Continue setup →</a>
						{:else}
							<div class="side-msg">Everything looks healthy here. Nothing for you to do today.</div>
							<a class="btn btn-outline btn-sm" href={`/stores/${s.id}`}>Open store →</a>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<!-- ── Create Store modal ──────────────────────────────────────── -->
{#if showCreate}
	<div class="modal-backdrop" on:click={() => (showCreate = false)} role="presentation">
		<div class="modal" on:click|stopPropagation role="dialog" aria-labelledby="create-store-title">
			<header class="modal-hdr">
				<h2 id="create-store-title">Add Store</h2>
				<button type="button" class="close" on:click={() => (showCreate = false)} aria-label="Close">×</button>
			</header>

			<p class="modal-sub">
				Step 1 of 2 — store details. Next, you'll connect your Amazon seller account via SP-API.
			</p>

			{#if form?.error}
				<div class="alert alert-error" style="margin-bottom:14px">{form.error}</div>
			{/if}

			<form
				method="POST"
				action="?/create_store"
				use:enhance={() => {
					saving = true;
					return ({ update }) => {
						saving = false;
						update();
					};
				}}
			>
				<div class="form-grid">
					<div class="form-group full">
						<label for="name">Store name <span class="req">*</span></label>
						<input id="name" name="name" type="text" class="form-control"
							required value={form?.name ?? ''} placeholder="Amazon US — Main" />
					</div>

					<div class="form-group">
						<label for="country">Country</label>
						<input id="country" name="country" type="text" class="form-control"
							value={form?.country ?? ''} placeholder="United States" />
					</div>
					<div class="form-group">
						<label for="businessName">Legal business name</label>
						<input id="businessName" name="businessName" type="text" class="form-control"
							value={form?.businessName ?? ''} placeholder="Acme Inc." />
					</div>

					<div class="form-group">
						<label for="sellerPrimaryEmail">Amazon notification email</label>
						<input id="sellerPrimaryEmail" name="sellerPrimaryEmail" type="email" class="form-control"
							value={form?.sellerPrimaryEmail ?? ''} placeholder="seller-account@amazon.com" />
						<div class="hint">Email Amazon uses for performance notifications</div>
					</div>
					<div class="form-group">
						<label for="storeEmail">Store contact email</label>
						<input id="storeEmail" name="storeEmail" type="email" class="form-control"
							value={form?.storeEmail ?? ''} placeholder="contact@acme.com" />
					</div>

					<div class="form-group full">
						<label for="description">Store description</label>
						<textarea id="description" name="description" rows="3" class="form-control"
							placeholder="What does this store sell, target market, etc.">{form?.description ?? ''}</textarea>
					</div>
				</div>

				<div class="modal-actions">
					<button type="button" class="btn btn-outline" on:click={() => (showCreate = false)}
						disabled={saving}>Cancel</button>
					<button type="submit" class="btn btn-primary" disabled={saving}>
						{saving ? 'Creating…' : 'Create & continue to connect →'}
					</button>
				</div>
			</form>
		</div>
	</div>
{/if}

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }

	/* ── 2b: empty onboarding state ── */
	.empty-onboard {
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 40px; max-width: 620px; margin: 20px auto;
	}
	.empty-onboard h2 { font-size: 22px; color: var(--navy); margin: 0 0 10px; }
	.empty-sub { font-size: 14px; color: var(--grey-text); line-height: 1.5; margin: 0 0 24px; }
	.steps { list-style: none; margin: 0 0 26px; padding: 0; display: flex; flex-direction: column; gap: 16px; }
	.steps li { display: flex; gap: 14px; align-items: flex-start; }
	.step-num {
		flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%;
		background: var(--orange-lt); color: var(--orange-dk); font-weight: 700; font-size: 13px;
		display: flex; align-items: center; justify-content: center;
	}
	.step-title { font-weight: 700; color: var(--navy); font-size: 14px; margin-bottom: 2px; }
	.step-body { font-size: 13px; color: var(--grey-text); line-height: 1.4; }
	.empty-hint { font-size: 12px; color: var(--grey-text); margin-top: 10px; }

	/* ── 2a: health banner ── */
	.health-banner {
		display: flex; align-items: center; gap: 14px;
		background: var(--orange-lt); border: 1px solid var(--orange);
		border-radius: var(--radius); padding: 14px 18px; margin-bottom: 18px;
	}
	.warn-icon { font-size: 20px; flex-shrink: 0; }
	.health-banner-text { flex: 1; font-size: 13px; color: var(--navy); line-height: 1.5; }

	/* ── 2a: store rows ── */
	.toolbar { display: flex; align-items: center; gap: 16px; margin-bottom: 14px; }
	.search-wrap { flex: 1; max-width: 420px; }
	.count { font-size: 13px; color: var(--grey-text); margin-left: auto; }
	.no-match {
		background: white; border: 1px dashed var(--grey-line);
		border-radius: var(--radius); padding: 20px; text-align: center;
		font-size: 13px; color: var(--grey-text); margin-bottom: 14px;
	}

	.store-list { display: flex; flex-direction: column; gap: 14px; }
	.store-row {
		display: flex; gap: 24px; justify-content: space-between;
		background: white; border: 1px solid var(--grey-line);
		border-radius: var(--radius); padding: 18px 22px;
	}
	.store-row.attention { border-color: var(--orange); }
	.store-row-main { flex: 1; min-width: 0; }
	.store-row-hdr { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
	.store-name { font-size: 15px; font-weight: 700; color: var(--navy); text-decoration: none; }
	.store-name:hover { text-decoration: underline; }
	.store-meta { font-size: 12px; color: var(--grey-text); margin-bottom: 14px; }

	.stat-row { display: flex; gap: 40px; }
	.stat-lbl {
		font-size: 10px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text); margin-bottom: 4px;
	}
	.stat-val { font-size: 18px; font-weight: 700; color: var(--navy); }
	.stat-sub { font-size: 11px; color: var(--grey-text); margin-top: 2px; }

	.setup-steps { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 12px; }
	.setup-count { font-size: 11px; font-weight: 700; color: var(--grey-text); text-transform: uppercase; letter-spacing: .04em; }
	.setup-step { color: var(--grey-text); }
	.setup-step.done { color: var(--green); font-weight: 600; }

	.store-row-side {
		flex-shrink: 0; width: 220px; display: flex; flex-direction: column;
		align-items: flex-end; justify-content: center; gap: 10px; text-align: right;
	}
	.side-msg { font-size: 12px; color: var(--grey-text); line-height: 1.4; }

	/* Modal */
	.modal-backdrop {
		position: fixed; inset: 0; background: rgba(15, 23, 42, 0.55);
		display: grid; place-items: center; padding: 24px; z-index: 100;
	}
	.modal {
		background: white; border-radius: 20px; padding: 28px;
		width: 100%; max-width: 720px; max-height: 90vh; overflow-y: auto;
		box-shadow: var(--shadow-xl);
	}
	.modal-hdr { display: flex; justify-content: space-between; align-items: center; }
	.modal-hdr h2 { font-size: 20px; font-weight: 800; color: var(--navy); margin: 0; }
	.close {
		background: none; border: none; font-size: 26px; line-height: 1;
		color: var(--grey-text); cursor: pointer; padding: 0; width: 32px; height: 32px;
	}
	.close:hover { color: var(--navy); }
	.modal-sub { font-size: 14px; color: var(--grey-text); margin: 6px 0 18px; }

	.form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
	.form-grid .full { grid-column: 1 / -1; }
	.req { color: var(--orange); }
	.hint { font-size: 11px; color: var(--grey-text); margin-top: 4px; }

	.modal-actions {
		display: flex; justify-content: flex-end; gap: 10px;
		margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--grey-line);
	}

</style>
