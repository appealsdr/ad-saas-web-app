<script lang="ts">
	import Topbar from '$components/layout/Topbar.svelte';
	import ConversationPanel from '$components/messages/ConversationPanel.svelte';
	import { dayLabel } from '$components/messages/conversation-utils';
	import type { PageData } from './$types';

	export let data: PageData;

	const fmtTime = (iso: string) => {
		try {
			return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
		} catch {
			return '';
		}
	};
	const when = (iso: string) => `${dayLabel(iso)} · ${fmtTime(iso)}`;
	const badge = (n: number) => (n > 99 ? '99+' : String(n));

	// Collapsed stores in the channel list (all expanded by default).
	let collapsed = new Set<string>();
	function toggle(id: string) {
		const next = new Set(collapsed);
		next.has(id) ? next.delete(id) : next.add(id);
		collapsed = next;
	}
</script>

<svelte:head><title>Messages — Appeals Doctor</title></svelte:head>

<Topbar title="Messages" subtitle="Everything exchanged with Appeals Doctor for your account" />

<div class="content-area">
	{#if data.account === null}
		<div class="alert alert-warn">No account is linked to your user yet, so messages are unavailable.</div>
	{:else}
		<div class="msg-shell">
			<!-- ── Left: channels ─────────────────────────────── -->
			<nav class="channels" aria-label="Conversations">
				<div class="ch-account">
					<div class="ch-logo" aria-hidden="true">{(data.account.name || 'A').charAt(0).toUpperCase()}</div>
					<div class="ch-account-name" title={data.account.name}>{data.account.name}</div>
				</div>

				{#await data.overview}
					<div class="ch-loading" role="status" aria-busy="true">Loading conversations…</div>
				{:then overview}
					<div class="ch-group">
						<div class="ch-heading">ACCOUNT</div>
						<a class="ch-item active" href="/messages" aria-current="page">
							<span aria-hidden="true">#</span><span class="grow">Account chat</span>
							{#if overview && overview.accountUnread > 0}<span class="ch-badge" aria-label="{overview.accountUnread} unread">{badge(overview.accountUnread)}</span>{/if}
						</a>
					</div>
					<div class="ch-group">
						<div class="ch-heading">STORES</div>
						{#if !overview || overview.stores.length === 0}
							<div class="ch-empty">{overview ? 'No stores yet.' : 'Could not load stores.'}</div>
						{/if}
						{#each overview?.stores ?? [] as s (s.id)}
							<div class="ch-store">
								<div class="ch-item store">
									<button
										type="button"
										class="ch-caret"
										aria-expanded={!collapsed.has(s.id)}
										aria-label="{collapsed.has(s.id) ? 'Expand' : 'Collapse'} {s.name}"
										on:click={() => toggle(s.id)}>{collapsed.has(s.id) ? '▸' : '▾'}</button
									>
									<a class="grow link" href={s.href}>{s.name}</a>
									{#if s.totalUnread > 0}<span class="ch-badge" aria-label="{s.totalUnread} unread">{badge(s.totalUnread)}</span>{/if}
								</div>
								{#if !collapsed.has(s.id)}
									<div class="ch-cases">
										<a class="ch-item sub" href={s.href}>
											<span aria-hidden="true">#</span><span class="grow">Store chat</span>
											{#if s.storeUnread > 0}<span class="ch-badge" aria-label="{s.storeUnread} unread">{badge(s.storeUnread)}</span>{/if}
										</a>
										{#each s.cases as c (c.id)}
											<a class="ch-item sub" class:dim={c.unread === 0} href={c.href} title={c.label}>
												<span class="grow ellipsis">{c.label}</span>
												{#if c.unread > 0}<span class="ch-badge" aria-label="{c.unread} unread">{badge(c.unread)}</span>{/if}
											</a>
										{/each}
									</div>
								{/if}
							</div>
						{/each}
					</div>
					{#if overview?.partial}
						<div class="ch-note" role="note">Some conversations couldn't be loaded, so unread counts may be incomplete.</div>
					{/if}
				{/await}
			</nav>

			<!-- ── Center: Account chat ───────────────────────── -->
			<section class="chat" aria-label="Account chat">
				{#await data.conversation}
					<ConversationPanel loading variant="channel" title="# Account chat" idPrefix="msgtab" />
				{:then conversation}
					<ConversationPanel
						{conversation}
						variant="channel"
						title="# Account chat"
						scopeSubtitle={data.account.name}
						composerPlaceholder="Message Account chat"
						idPrefix="msgtab"
					>
						<svelte:fragment slot="thread-end">
							{#await data.overview then overview}
								{#if overview && overview.stores.some((s) => s.totalUnread > 0)}
									<div class="digest-row">
										<div class="digest-avatar" aria-hidden="true">✦</div>
										<div class="digest-body">
											<div class="digest-head"><b>Activity</b><span class="digest-app">APP</span></div>
											<div class="digest">
												<div class="digest-title">New messages below this account</div>
												{#each overview.stores.filter((s) => s.totalUnread > 0) as s (s.id)}
													<div class="digest-line">
														<b>{s.name}</b> ·
														{#if s.storeUnread > 0}{s.storeUnread} in store chat{/if}{#if s.storeUnread > 0 && s.caseUnread > 0}
															·
														{/if}{#if s.caseUnread > 0}{s.caseUnread} in {s.cases.filter((c) => c.unread > 0).length === 1 ? s.cases.find((c) => c.unread > 0)?.label.split(' · ')[0] : 'cases'}{/if}
													</div>
												{/each}
												<div class="digest-total">{overview.totalUnread} unread in total</div>
											</div>
										</div>
									</div>
								{/if}
							{/await}
						</svelte:fragment>
					</ConversationPanel>
				{/await}
			</section>

			<!-- ── Right: stores below this account ───────────── -->
			<aside class="below" aria-label="Stores below this account">
				<div class="below-head">
					<div class="below-title">Stores below this account</div>
					{#await data.overview then overview}<span class="below-count">{overview?.stores.length ?? 0}</span>{/await}
				</div>
				<div class="below-list">
					{#await data.overview}
						<div class="ch-loading" role="status" aria-busy="true">Loading…</div>
					{:then overview}
						{#each overview?.stores ?? [] as s (s.id)}
							<div class="store-card">
								<div class="sc-top">
									<b class="grow ellipsis">{s.name}</b>
									{#if s.totalUnread > 0}<span class="sc-new">{badge(s.totalUnread)} new</span>{:else}<span class="sc-read">All read</span>{/if}
								</div>
								<div class="sc-sub">Store chat · {s.caseCount} {s.caseCount === 1 ? 'case' : 'cases'}</div>
								{#if !s.linked}
									<div class="sc-last muted">Not linked to Salesforce yet.</div>
								{:else if s.lastMessage}
									<div class="sc-last">
										<b>{s.lastMessage.author}:</b>
										{s.lastMessage.preview || '(no text)'}
										<div class="sc-when">
											{s.lastMessage.source === 'case' && s.lastMessage.caseNumber ? `Case #${s.lastMessage.caseNumber} · ` : ''}{when(s.lastMessage.createdAt)}
										</div>
									</div>
								{:else}
									<div class="sc-last muted">No recent messages.</div>
								{/if}
								<a class="sc-open" href={s.href}>Open store chat</a>
							</div>
						{:else}
							<p class="ch-empty">No stores yet.</p>
						{/each}
					{/await}
				</div>
			</aside>
		</div>
	{/if}
</div>

<style>
	.msg-shell {
		display: grid; grid-template-columns: 260px minmax(0, 1fr) 320px;
		height: calc(100vh - 190px); min-height: 560px;
		background: #fff; border: 1px solid var(--grey-line, #e0e6ef); border-radius: 14px; overflow: hidden;
	}
	.grow { flex: 1; min-width: 0; }
	.ellipsis { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

	/* Channels (navy sidebar) */
	.channels { background: #1b2b4b; color: #c9d3e6; display: flex; flex-direction: column; gap: 14px; padding: 14px 10px; overflow-y: auto; }
	.ch-account { display: flex; align-items: center; gap: 10px; padding: 0 6px; }
	.ch-logo { width: 34px; height: 34px; border-radius: 9px; background: #f5a100; color: #1b2b4b; font-weight: 800; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
	.ch-account-name { flex: 1; min-width: 0; font-weight: 700; color: #fff; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ch-heading { font-size: 11px; font-weight: 700; letter-spacing: .06em; color: #8fa0c2; padding: 0 10px 4px; }
	.ch-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 6px; color: #fff; font-weight: 700; text-decoration: none; font-size: 14px; }
	.ch-item.active { background: #2a3f6f; box-shadow: inset 3px 0 0 #f5a100; }
	.ch-item:hover:not(.active) { background: rgba(255,255,255,.07); }
	.ch-item:focus-visible, .ch-caret:focus-visible { outline: 2px solid #f5a100; outline-offset: 1px; }
	.ch-item.store { padding: 4px 10px 4px 4px; }
	.ch-item.store .link { color: #fff; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.ch-item.sub { padding: 5px 10px; font-size: 13px; }
	.ch-item.dim { color: #c9d3e6; font-weight: 500; }
	.ch-caret { background: none; border: 0; color: #c9d3e6; cursor: pointer; font-size: 11px; width: 24px; min-height: 28px; }
	.ch-cases { margin-left: 20px; padding-left: 8px; border-left: 1px solid #2a3f6f; }
	.ch-badge { background: #f5a100; color: #1b2b4b; font-size: 11px; font-weight: 800; border-radius: 999px; min-width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; padding: 0 5px; }
	.ch-loading, .ch-empty, .ch-note { font-size: 12px; color: #8fa0c2; padding: 4px 10px; }
	.below .ch-loading, .below .ch-empty { color: var(--grey-text, #5a6886); }

	/* Chat */
	.chat { min-width: 0; min-height: 0; display: flex; flex-direction: column; border-right: 1px solid var(--grey-line, #e0e6ef); }
	.digest-row { display: flex; gap: 12px; padding: 8px 22px; }
	.digest-avatar { width: 36px; height: 36px; flex-shrink: 0; border-radius: 8px; background: #1b2b4b; color: #f5a100; display: flex; align-items: center; justify-content: center; }
	.digest-body { flex: 1; min-width: 0; }
	.digest-head { display: flex; gap: 8px; align-items: baseline; }
	.digest-app { background: #e0e6ef; color: #1b2b4b; border-radius: 4px; padding: 0 6px; font-size: 11px; font-weight: 700; }
	.digest { margin-top: 4px; border: 1px solid #e0e6ef; border-left: 4px solid #f5a100; border-radius: 8px; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 13px; }
	.digest-title { font-weight: 700; }
	.digest-total { color: var(--grey-text, #5a6886); font-size: 12px; }

	/* Stores below */
	.below { background: #f6f8fb; display: flex; flex-direction: column; min-height: 0; }
	.below-head { height: 60px; box-sizing: border-box; padding: 0 18px; border-bottom: 1px solid #e0e6ef; display: flex; align-items: center; }
	.below-title { font-weight: 800; font-size: 14px; flex: 1; }
	.below-count { font-size: 12px; color: var(--grey-text, #5a6886); }
	.below-list { padding: 14px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
	.store-card { background: #fff; border: 1px solid #e0e6ef; border-radius: 10px; padding: 12px; }
	.sc-top { display: flex; align-items: center; gap: 8px; }
	.sc-new { background: #f5a100; color: #1b2b4b; font-size: 11px; font-weight: 800; border-radius: 999px; padding: 0 8px; height: 20px; display: inline-flex; align-items: center; }
	.sc-read { font-size: 12px; color: var(--grey-text, #5a6886); }
	.sc-sub { font-size: 12px; color: var(--grey-text, #5a6886); margin-top: 2px; }
	.sc-last { font-size: 13px; margin-top: 8px; border-left: 3px solid #e0e6ef; padding-left: 8px; word-break: break-word; }
	.sc-last.muted { color: var(--grey-text, #5a6886); }
	.sc-when { font-size: 11px; color: var(--grey-text, #5a6886); margin-top: 2px; }
	.sc-open { display: inline-block; margin-top: 10px; font-size: 13px; font-weight: 700; color: #1b2b4b; text-decoration: underline; min-height: 24px; }

	@media (max-width: 1180px) {
		.msg-shell { grid-template-columns: 240px minmax(0, 1fr); }
		.below { display: none; }
	}
	@media (max-width: 800px) {
		.msg-shell { grid-template-columns: 1fr; height: auto; }
		.channels { max-height: 260px; }
		.chat { height: 640px; border-right: 0; }
		.below { display: flex; }
	}
</style>
