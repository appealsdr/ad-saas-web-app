<script lang="ts">
	/**
	 * Shared App Message conversation — used for Account, Store and Case contexts.
	 *
	 * The host page passes SERVER-OWNED data (`conversation`: context type + id +
	 * sanitized messages) and the names of its form actions. The component never
	 * sends a Salesforce id to the server: the actions re-resolve the context from
	 * the route + session, so arbitrary client input can't redirect a read/write.
	 *
	 * States: loading, unavailable (not linked to Salesforce), error + retry,
	 * empty, populated (day dividers, unread divider, replies), search, refresh,
	 * rich-text composer, message detail modal (focus-trapped, Esc to close).
	 */
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { tick, onMount, createEventDispatcher } from 'svelte';
	import RichTextEditor from '$components/ui/RichTextEditor.svelte';
	import type { AppMessage, ConversationData } from '$lib/types/app-message';
	import {
		filterMessages,
		firstUnreadId,
		dayLabel,
		initials,
		isInternalSender,
		plainPreview,
		sortMessages
	} from './conversation-utils';

	/** Null while the host page is still streaming the conversation in. */
	export let conversation: ConversationData | null = null;
	export let loading = false;
	/** Heading, e.g. "Account messages", "Store messages", "Messages". */
	export let title = 'Messages';
	/** Small badge in the header, e.g. "All stores" / "This store only". */
	export let scopeBadge: string | null = null;
	/** Subtitle under the heading, e.g. the account or store name. */
	export let scopeSubtitle: string | null = null;
	/** Header treatment from the design: account = navy, store/case = light. */
	export let tone: 'navy' | 'light' = 'light';
	/** 'card' = bordered card (account/store/case pages); 'channel' = Slack-style full-height channel. */
	export let variant: 'card' | 'channel' = 'card';
	export let composerPlaceholder = 'Write a message…';
	export let postAction = '?/post_message';
	export let readAction = '?/mark_read';
	/** Fixed card height in px (scrolls internally). */
	export let height = 560;
	/** Prefix for element ids when several panels share a page. */
	export let idPrefix = 'conv';

	const dispatch = createEventDispatcher<{ read: { id: string } }>();
	let input = '';
	let search = '';
	let posting = false;
	let refreshing = false;
	let sendError: string | null = null;
	let announcement = '';
	let listEl: HTMLDivElement;
	let composerEl: HTMLFormElement;

	$: contactId = conversation?.currentContactId ?? null;
	$: messages = conversation?.messages ?? [];
	$: sorted = sortMessages(messages);
	$: byId = new Map(sorted.map((m) => [m.Id, m]));
	$: visible = filterMessages(sorted, search);
	$: unreadDividerId = firstUnreadId(sorted, contactId);
	$: unreadCount = sorted.filter((m) => !m.messageRead && !isMine(m)).length;

	function isMine(m: Pick<AppMessage, 'senderContactId'>): boolean {
		return !!contactId && contactId === m.senderContactId;
	}
	function author(m: AppMessage): string {
		return m.displayName ?? m.senderContactName ?? m.createdByName ?? 'Unknown';
	}
	function fmtTime(iso: string): string {
		try {
			return new Date(iso)
				.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
				.toLowerCase();
		} catch {
			return iso;
		}
	}
	function fmtDateTime(iso: string): string {
		try {
			const d = new Date(iso);
			return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })} at ${fmtTime(iso)}`;
		} catch {
			return iso;
		}
	}
	function avatarColor(m: AppMessage): string {
		if (isMine(m)) return 'var(--green, #15803d)';
		return isInternalSender(m.senderType) ? 'var(--navy-soft, #2a3f6f)' : 'var(--blue, #2563eb)';
	}
	/** Day divider shown above m when it starts a new calendar day. */
	function dividerFor(i: number): string | null {
		const m = visible[i];
		const label = dayLabel(m.createdAt);
		const prev = visible[i - 1];
		return !prev || dayLabel(prev.createdAt) !== label ? label : null;
	}

	// ── Read tracking (Message_Read__c). Local overrides until the next reload. ──
	let readOverrides = new Set<string>();
	const isRead = (m: AppMessage) => !!m.messageRead || readOverrides.has(m.Id);
	const isUnread = (m: AppMessage) => !isRead(m) && !isMine(m);
	async function markRead(m: AppMessage) {
		if (isRead(m) || isMine(m)) return;
		readOverrides = new Set(readOverrides).add(m.Id);
		dispatch('read', { id: m.Id });
		try {
			const body = new FormData();
			body.set('messageId', m.Id);
			await fetch(readAction, { method: 'POST', body });
		} catch {
			// Best-effort — a failed read receipt isn't worth surfacing.
		}
	}

	// ── Reply ──
	let replyingTo: AppMessage | null = null;
	async function startReply(m: AppMessage) {
		replyingTo = m;
		closeModal();
		await tick();
		composerEl?.querySelector<HTMLElement>('.rte-editor')?.focus();
	}

	// ── Detail modal (focus management) ──
	let selected: AppMessage | null = null;
	let dialogEl: HTMLDivElement;
	let returnFocusTo: HTMLElement | null = null;
	async function openModal(m: AppMessage, trigger: EventTarget | null) {
		returnFocusTo = trigger instanceof HTMLElement ? trigger : null;
		selected = m;
		markRead(m);
		await tick();
		dialogEl?.focus();
	}
	function closeModal() {
		if (!selected) return;
		selected = null;
		returnFocusTo?.focus();
		returnFocusTo = null;
	}
	function onDialogKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			closeModal();
			return;
		}
		if (e.key !== 'Tab') return;
		// Keep focus inside the dialog.
		const focusables = dialogEl.querySelectorAll<HTMLElement>('button:not([disabled])');
		if (!focusables.length) return;
		const first = focusables[0];
		const last = focusables[focusables.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	// ── Refresh / retry ──
	async function refresh() {
		if (refreshing) return;
		refreshing = true;
		announcement = 'Refreshing messages…';
		try {
			await invalidateAll();
			announcement = 'Messages refreshed.';
		} finally {
			refreshing = false;
		}
	}

	// ── Scroll to latest ──
	async function scrollToLatest(smooth = false) {
		await tick();
		listEl?.scrollTo({ top: listEl.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
	}
	onMount(() => scrollToLatest());
	$: count = messages.length;
	$: count, scrollToLatest();
</script>

<section
	class="conv"
	class:navy={tone === 'navy'}
	class:channel={variant === 'channel'}
	style={variant === 'channel' ? 'height:100%' : `height:${height}px`}
	data-context-type={conversation?.contextType ?? ''}
	data-context-id={conversation?.contextId ?? ''}
	aria-label={title}
>
	<header class="conv-head">
		<div class="conv-head-text">
			<h2 class="conv-title">{title}</h2>
			{#if scopeSubtitle}<div class="conv-sub">{scopeSubtitle}</div>{/if}
		</div>
		{#if scopeBadge}<span class="conv-scope">{scopeBadge}</span>{/if}
		{#if unreadCount > 0}
			<span class="conv-unread-pill" aria-label="{unreadCount} unread">{unreadCount} new</span>
		{/if}
		<button
			type="button"
			class="conv-refresh"
			on:click={refresh}
			disabled={refreshing || loading || !conversation?.available}
			aria-label="Refresh messages"
			title="Refresh messages"
		>
			<span class:spin={refreshing} aria-hidden="true">↻</span>
		</button>
	</header>

	<div class="sr-only" role="status" aria-live="polite">{announcement}</div>

	{#if loading || !conversation}
		<div class="conv-state" role="status" aria-busy="true">
			<span class="conv-spinner" aria-hidden="true"></span>
			Loading messages…
		</div>
	{:else if !conversation.available}
		<div class="conv-state conv-unavailable" role="note">
			<strong>Messages unavailable</strong>
			<span>{conversation.unavailableReason ?? 'This conversation is not available right now.'}</span>
		</div>
	{:else}
		<div class="conv-search">
			<label class="sr-only" for="{idPrefix}-search">Search messages</label>
			<input
				id="{idPrefix}-search"
				type="search"
				class="conv-search-input"
				placeholder="Search messages…"
				bind:value={search}
			/>
		</div>

		{#if conversation.error}
			<div class="alert alert-error conv-error" role="alert">
				<span>{conversation.error}</span>
				<button type="button" class="btn btn-outline btn-sm" on:click={refresh} disabled={refreshing}>
					{refreshing ? 'Retrying…' : 'Retry'}
				</button>
			</div>
		{/if}

		<div
			class="conv-list"
			bind:this={listEl}
			role="log"
			aria-label="{title} thread"
			aria-busy={refreshing}
			tabindex="-1"
		>
			{#each visible as m, i (m.Id)}
				{@const day = dividerFor(i)}
				{@const mine = isMine(m)}
				{@const name = author(m)}
				{@const internal = isInternalSender(m.senderType)}
				{@const parent = m.replyToMessageId ? (byId.get(m.replyToMessageId) ?? null) : null}
				{#if day}
					<div class="conv-day" role="separator"><span>{day}</span></div>
				{/if}
				{#if m.Id === unreadDividerId && !search.trim()}
					<div class="conv-unread-divider" role="separator">
						<span>{unreadCount} new {unreadCount === 1 ? 'message' : 'messages'}</span>
					</div>
				{/if}
				<div
					class="conv-row"
					class:unread={isUnread(m)}
					class:internal
					role="button"
					tabindex="0"
					aria-label="Open message from {name}{isUnread(m) ? ' (unread)' : ''}"
					on:click={(e) => openModal(m, e.currentTarget)}
					on:keydown={(e) => {
						if (e.target !== e.currentTarget) return;
						if (e.key === 'Enter' || e.key === ' ') {
							e.preventDefault();
							openModal(m, e.currentTarget);
						}
					}}
				>
					<div class="conv-avatar" style="background:{avatarColor(m)}" aria-hidden="true">
						{initials(name)}
					</div>
					<div class="conv-content">
						<div class="conv-meta">
							<span class="conv-sender">{name}{mine ? ' (You)' : ''}</span>
							<span class="conv-badge" class:team={internal}>{internal ? 'Team' : 'Client'}</span>
							<time class="conv-time" datetime={m.createdAt}>{fmtTime(m.createdAt)}</time>
							{#if isUnread(m)}<span class="conv-dot" aria-hidden="true"></span>{/if}
							<button
								type="button"
								class="conv-reply-btn"
								data-mutates
								disabled={!conversation.canSend}
								on:click|stopPropagation={() => startReply(m)}
							>
								↩ Reply
							</button>
						</div>
						{#if parent}
							<div class="conv-quote">
								<span class="conv-quote-author">{author(parent)}</span>
								<span class="conv-quote-text">{plainPreview(parent.body)}</span>
							</div>
						{:else if m.replyToMessageId}
							<div class="conv-quote"><span class="conv-quote-text">In reply to an earlier message</span></div>
						{/if}
						<div class="conv-body">{@html m.body ?? ''}</div>
					</div>
				</div>
			{:else}
				<p class="conv-empty">
					{#if search.trim()}
						No messages match "{search.trim()}".
					{:else}
						No messages yet — start the conversation below.
					{/if}
				</p>
			{/each}
			<slot name="thread-end" />
		</div>

		<form
			class="conv-composer"
			method="POST"
			action={postAction}
			bind:this={composerEl}
			use:enhance={() => {
				posting = true;
				sendError = null;
				return async ({ result, update }) => {
					posting = false;
					if (result.type === 'failure') {
						sendError =
							(result.data as { messageError?: string } | undefined)?.messageError ??
							'Could not send the message.';
						announcement = `Message not sent. ${sendError}`;
						return;
					}
					if (result.type === 'success') {
						input = '';
						replyingTo = null;
						announcement = 'Message sent.';
						await update({ reset: false });
						scrollToLatest(true);
						return;
					}
					await update({ reset: false });
				};
			}}
		>
			{#if replyingTo}
				<div class="conv-reply-preview">
					<div class="conv-reply-text">
						<span class="conv-reply-lbl">Replying to {author(replyingTo)}</span>
						<span class="conv-reply-body">{plainPreview(replyingTo.body)}</span>
					</div>
					<button
						type="button"
						class="conv-reply-x"
						on:click={() => (replyingTo = null)}
						aria-label="Cancel reply"
					>✕</button>
				</div>
			{/if}
			{#if !conversation.canSend && conversation.sendDisabledReason}
				<div class="alert alert-warn conv-warn" role="note">{conversation.sendDisabledReason}</div>
			{:else}
				<RichTextEditor bind:value={input} placeholder={composerPlaceholder} />
				<input type="hidden" name="body" value={input} />
				<input type="hidden" name="replyToMessageId" value={replyingTo?.Id ?? ''} />
				<div class="conv-actions">
					<button type="submit" class="btn btn-primary btn-sm" disabled={posting}>
						{posting ? 'Sending…' : 'Send'}
					</button>
				</div>
			{/if}
			{#if sendError}
				<div class="alert alert-error conv-send-error" role="alert">{sendError}</div>
			{/if}
		</form>
	{/if}
</section>

{#if selected}
	{@const m = selected}
	{@const name = author(m)}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="conv-overlay" on:click={closeModal} role="presentation">
		<div
			class="conv-modal"
			bind:this={dialogEl}
			on:click|stopPropagation
			on:keydown={onDialogKeydown}
			role="dialog"
			aria-modal="true"
			aria-labelledby="{idPrefix}-modal-title"
			tabindex="-1"
		>
			<header class="conv-modal-head">
				<h3 id="{idPrefix}-modal-title">Message from {name}</h3>
				<button type="button" class="conv-modal-x" on:click={closeModal} aria-label="Close">✕</button>
			</header>
			<div class="conv-modal-body">
				<div class="conv-modal-meta">
					<div class="conv-avatar lg" style="background:{avatarColor(m)}" aria-hidden="true">
						{initials(name)}
					</div>
					<div>
						<div class="conv-meta">
							<span class="conv-sender">{name}{isMine(m) ? ' (You)' : ''}</span>
							<span class="conv-badge" class:team={isInternalSender(m.senderType)}>
								{isInternalSender(m.senderType) ? 'Team' : 'Client'}
							</span>
						</div>
						<div class="conv-time">{fmtDateTime(m.createdAt)}</div>
					</div>
				</div>
				<div class="conv-modal-text">{@html m.body ?? ''}</div>
			</div>
			<footer class="conv-modal-foot">
				<button type="button" class="btn btn-outline btn-sm" on:click={closeModal}>Close</button>
				<button
					type="button"
					class="btn btn-primary btn-sm"
					data-mutates
					disabled={!conversation?.canSend}
					on:click={() => startReply(m)}>↩ Reply</button
				>
			</footer>
		</div>
	</div>
{/if}

<style>
	.sr-only {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}
	.conv {
		display: flex; flex-direction: column; min-height: 320px; max-height: 90vh;
		background: #fff; border: 1px solid var(--grey-line, #e0e6ef);
		border-radius: 14px; overflow: hidden;
	}
	.conv-head {
		display: flex; align-items: center; gap: 10px; flex-shrink: 0;
		padding: 12px 16px; border-bottom: 1px solid var(--grey-line, #e0e6ef);
		background: #fff; color: var(--navy, #1b2b4b);
	}
	.conv.navy .conv-head { background: var(--navy, #1b2b4b); color: #fff; border-bottom-color: transparent; }
	.conv-head-text { flex: 1; min-width: 0; }
	.conv-title { margin: 0; font-size: 15px; font-weight: 800; }
	.conv-sub { font-size: 12px; color: var(--grey-text, #5a6886); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.conv.navy .conv-sub { color: #c9d3e6; }
	.conv-scope {
		font-size: 11px; font-weight: 700; border-radius: 999px; padding: 3px 10px; white-space: nowrap;
		background: #fff4dc; color: var(--navy, #1b2b4b); border: 1px solid #f5a100;
	}
	.conv.navy .conv-scope { background: #fff; border-color: #fff; }
	.conv-unread-pill {
		background: #f5a100; color: #1b2b4b; font-size: 11px; font-weight: 800;
		border-radius: 999px; padding: 2px 8px;
	}
	.conv-refresh {
		width: 32px; height: 32px; border-radius: 8px; border: 1px solid var(--grey-line, #e0e6ef);
		background: transparent; color: inherit; cursor: pointer; font-size: 16px; line-height: 1;
	}
	.conv-refresh:disabled { opacity: .5; cursor: not-allowed; }
	.conv-refresh:focus-visible, .conv-reply-btn:focus-visible, .conv-row:focus-visible,
	.conv-modal-x:focus-visible, .conv-reply-x:focus-visible {
		outline: 2px solid var(--orange, #f5a100); outline-offset: 2px;
	}
	.spin { display: inline-block; animation: conv-spin .8s linear infinite; }
	@keyframes conv-spin { to { transform: rotate(360deg); } }

	.conv-state {
		flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
		gap: 8px; padding: 24px; text-align: center; font-size: 13px; color: var(--grey-text, #5a6886);
	}
	.conv-unavailable strong { color: var(--navy, #1b2b4b); font-size: 14px; }
	.conv-spinner {
		width: 22px; height: 22px; border-radius: 50%;
		border: 3px solid var(--grey-line, #e0e6ef); border-top-color: var(--orange, #f5a100);
		animation: conv-spin .8s linear infinite;
	}

	.conv-search { padding: 10px 16px; border-bottom: 1px solid var(--grey-line, #e0e6ef); flex-shrink: 0; }
	.conv-search-input {
		width: 100%; box-sizing: border-box; border: 1.5px solid var(--grey-line, #e0e6ef);
		border-radius: 9px; padding: 8px 12px; font-size: 13px; font-family: inherit; min-height: 36px;
	}
	.conv-search-input:focus { outline: none; border-color: var(--orange, #f5a100); }
	.conv-error { margin: 10px 16px 0; display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-shrink: 0; }

	.conv-list { flex: 1; min-height: 0; overflow-y: auto; padding: 6px 0; }
	.conv-empty { color: var(--grey-text, #5a6886); font-size: 13px; margin: 0; padding: 20px 16px; text-align: center; }
	.conv-day, .conv-unread-divider {
		display: flex; align-items: center; gap: 12px; padding: 10px 16px 4px;
		font-size: 11px; font-weight: 700; color: var(--grey-text, #5a6886);
	}
	.conv-day::before, .conv-day::after, .conv-unread-divider::before, .conv-unread-divider::after {
		content: ''; flex: 1; height: 1px; background: var(--grey-line, #e0e6ef);
	}
	.conv-unread-divider { color: #991b1b; }
	.conv-unread-divider::before, .conv-unread-divider::after { background: #ef4444; }

	.conv-row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 16px; cursor: pointer; transition: background-color .15s; }
	.conv-row:hover { background: var(--grey-bg, #f6f8fb); }
	.conv-row.internal { background: rgba(27, 43, 75, .035); }
	.conv-row.unread { background: #fff7e0; }
	.conv-row.unread:hover { background: #fdecc4; }
	.conv-avatar {
		width: 34px; height: 34px; border-radius: 8px; flex-shrink: 0; margin-top: 1px;
		display: flex; align-items: center; justify-content: center;
		font-size: 12px; font-weight: 700; color: #fff;
	}
	.conv-avatar.lg { width: 38px; height: 38px; font-size: 13px; }
	.conv-content { min-width: 0; flex: 1; }
	.conv-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-bottom: 2px; }
	.conv-sender { font-size: 13px; font-weight: 700; color: var(--navy, #1b2b4b); }
	.conv-time { font-size: 11px; color: var(--grey-text, #5a6886); white-space: nowrap; }
	.conv-dot { width: 8px; height: 8px; border-radius: 50%; background: #f5a100; }
	.conv-badge {
		font-size: 10px; font-weight: 700; line-height: 1; padding: 2px 6px; border-radius: 4px;
		background: #fff4dc; border: 1px solid #f5a100; color: var(--navy, #1b2b4b);
	}
	.conv-badge.team { background: #e0e6ef; border-color: transparent; }
	.conv-reply-btn {
		margin-left: auto; background: none; border: none; cursor: pointer; min-height: 28px;
		font-size: 11px; font-weight: 600; color: var(--grey-text, #5a6886);
		padding: 1px 6px; border-radius: 5px; opacity: 0; transition: opacity .12s, color .12s;
	}
	.conv-row:hover .conv-reply-btn, .conv-row:focus-within .conv-reply-btn { opacity: 1; }
	.conv-reply-btn:hover:not(:disabled) { color: var(--orange, #f5a100); }
	.conv-reply-btn:disabled { cursor: not-allowed; }
	@media (hover: none) { .conv-reply-btn { opacity: 1; } }
	.conv-quote {
		display: flex; gap: 6px; align-items: baseline; margin-bottom: 3px; padding-left: 8px;
		border-left: 2px solid var(--grey-line, #e0e6ef); font-size: 11px; color: var(--grey-text, #5a6886); overflow: hidden;
	}
	.conv-quote-author { font-weight: 700; flex-shrink: 0; }
	.conv-quote-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.conv-body { font-size: 13px; line-height: 1.45; color: var(--navy-dark, #111d33); word-break: break-word; }
	.conv-body :global(ul), .conv-body :global(ol), .conv-modal-text :global(ul), .conv-modal-text :global(ol) { margin: 4px 0; padding-left: 22px; }

	.conv-composer { flex-shrink: 0; border-top: 1px solid var(--grey-line, #e0e6ef); padding: 10px 16px 12px; }
	.conv-actions { display: flex; justify-content: flex-end; margin-top: 8px; }
	.conv-warn, .conv-send-error { margin: 8px 0 0; }
	.conv-reply-preview {
		display: flex; align-items: center; gap: 8px; background: var(--grey-bg, #f6f8fb);
		border-left: 3px solid var(--orange, #f5a100); border-radius: 6px; padding: 6px 10px; margin-bottom: 8px;
	}
	.conv-reply-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
	.conv-reply-lbl { font-size: 11px; font-weight: 700; color: var(--orange-dk, #b45309); }
	.conv-reply-body { font-size: 12px; color: var(--grey-text, #5a6886); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
	.conv-reply-x { background: none; border: none; cursor: pointer; color: var(--grey-text, #5a6886); font-size: 13px; min-width: 28px; min-height: 28px; }
	.conv-reply-x:hover { color: #b91c1c; }

	.conv-overlay {
		position: fixed; inset: 0; background: rgba(15, 23, 42, .55);
		display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 24px;
	}
	.conv-modal {
		background: #fff; border-radius: 12px; width: min(560px, 100%); max-height: 85vh;
		display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow-xl, 0 20px 50px rgba(0,0,0,.3));
	}
	.conv-modal:focus { outline: none; }
	.conv-modal-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--grey-line, #e0e6ef); }
	.conv-modal-head h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy, #1b2b4b); }
	.conv-modal-x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text, #5a6886); min-width: 32px; min-height: 32px; }
	.conv-modal-body { padding: 18px; overflow: auto; }
	.conv-modal-meta { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
	.conv-modal-text { font-size: 14px; line-height: 1.5; color: var(--navy-dark, #111d33); word-break: break-word; border-top: 1px solid var(--grey-line, #e0e6ef); padding-top: 14px; }
	.conv-modal-foot { padding: 12px 18px; border-top: 1px solid var(--grey-line, #e0e6ef); display: flex; justify-content: flex-end; gap: 8px; }

	/* ── Channel (Slack-format) variant ── */
	.conv.channel { border: 0; border-radius: 0; max-height: none; min-height: 0; }
	.conv.channel .conv-head { min-height: 60px; box-sizing: border-box; padding: 0 22px; }
	.conv.channel .conv-title { font-size: 16px; }
	.conv.channel .conv-search { padding: 8px 22px; }
	.conv.channel .conv-list { padding: 8px 0; }
	.conv.channel .conv-day, .conv.channel .conv-unread-divider { padding: 12px 22px 6px; font-size: 12px; }
	.conv.channel .conv-row { padding: 6px 22px; gap: 12px; }
	.conv.channel .conv-row.internal { background: transparent; }
	.conv.channel .conv-row.internal:hover { background: var(--grey-bg, #f6f8fb); }
	.conv.channel .conv-row.unread { background: #fff7e0; }
	.conv.channel .conv-avatar { width: 36px; height: 36px; font-size: 13px; }
	.conv.channel .conv-body { font-size: 14px; }
	.conv.channel .conv-composer { border-top: 0; padding: 0 22px 18px; }
	.conv.channel .conv-composer :global(.rte) { border: 1px solid #c9d3e6; border-radius: 10px; }

	@media (max-width: 640px) {
		.conv { max-height: none; }
		.conv-head { flex-wrap: wrap; padding: 10px 12px; }
		.conv-row { padding: 8px 12px; }
		.conv-composer { padding: 8px 12px 10px; }
		.conv-overlay { padding: 12px; }
	}
	@media (prefers-reduced-motion: reduce) {
		.spin, .conv-spinner { animation: none; }
		.conv-row { transition: none; }
	}
</style>
