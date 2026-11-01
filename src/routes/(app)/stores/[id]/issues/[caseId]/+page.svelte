<script lang="ts">
	import { enhance } from '$app/forms';
	import { tick, onMount } from 'svelte';
	import Topbar from '$components/layout/Topbar.svelte';
	import CaseTimeline from '$components/cases/CaseTimeline.svelte';
	import RichTextEditor from '$components/ui/RichTextEditor.svelte';
	import RequiredFiles from '$components/files/RequiredFiles.svelte';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	let posting = false;
	let recalculating = false;
	let commentInput = '';
	let commentSearch = '';
	let commentsListEl: HTMLDivElement;
	let composerFormEl: HTMLFormElement;

	// ── Reply-to-message ──
	type Msg = (typeof data.messages)[number];
	let replyingTo: Msg | null = null;
	function startReply(m: Msg) {
		replyingTo = m;
		showMessageModal = false;
		tick().then(() => composerFormEl?.querySelector<HTMLElement>('.rte-editor')?.focus());
	}
	function cancelReply() {
		replyingTo = null;
	}

	// ── Read tracking — Message_Read__c ──
	// Messages come from the server load, so a locally-marked-read message
	// needs a client-side override until the next full reload picks up the
	// server value. `justReadIds` also drives the 5s unread→read color fade.
	let readOverrides = new Set<string>();
	function messageRead(m: Msg): boolean {
		return !!m.messageRead || readOverrides.has(m.Id);
	}
	function isUnread(m: Msg): boolean {
		return !messageRead(m) && !isMine(m);
	}
	async function markRead(m: Msg) {
		if (messageRead(m) || isMine(m)) return;
		readOverrides = new Set(readOverrides).add(m.Id); // triggers the CSS fade immediately
		try {
			const body = new FormData();
			body.set('messageId', m.Id);
			await fetch('?/mark_read', { method: 'POST', body });
		} catch {
			// Best-effort — a failed mark-read isn't worth surfacing to the user.
		}
	}

	// ── Status → mockup badge classes ──
	const STATUS_BADGE: Record<string, string> = {
		'new': 'badge-orange',
		'open': 'badge-orange',
		'working': 'badge-blue',
		'in progress': 'badge-blue',
		'waiting on client': 'badge-red',
		'waiting': 'badge-red',
		'pending': 'badge-red',
		'closed': 'badge-green',
		'resolved': 'badge-green'
	};
	function badgeClass(status: string): string {
		return STATUS_BADGE[status.toLowerCase()] ?? 'badge-grey';
	}
	function isWaitingOnClient(status: string): boolean {
		const s = status.toLowerCase();
		return s.includes('waiting') || s.includes('pending') || s.includes('awaiting');
	}

	// ── Formatters ──
	function fmtDate(iso: string | null | undefined) {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); }
		catch { return iso; }
	}
	function fmtDateTime(iso: string | null | undefined) {
		if (!iso) return '—';
		try {
			const d = new Date(iso);
			return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
				+ ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
		} catch { return iso; }
	}
	function fmtSize(bytes: number) {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
	}

	// ── Avatar initials + color ──
	function initials(name: string | null): string {
		if (!name) return '??';
		const parts = name.trim().split(/\s+/);
		return ((parts[0]?.[0] ?? '') + (parts[parts.length - 1]?.[0] ?? '')).toUpperCase() || '??';
	}
	function isInternal(senderType: string | null): boolean {
		return !!senderType && senderType.toLowerCase().includes('internal');
	}
	function avatarColor(senderType: string | null, mine: boolean): string {
		if (mine) return 'var(--green)';
		// Internal = our team (navy); external = client side (blue).
		return isInternal(senderType) ? 'var(--navy-soft)' : 'var(--blue)';
	}

	// ── Message detail modal ──
	let showMessageModal = false;
	let selectedMessage: Msg | null = null;
	function openMessage(m: Msg) {
		selectedMessage = m;
		showMessageModal = true;
		markRead(m);
	}
	function closeMessage() {
		showMessageModal = false;
		selectedMessage = null;
	}
	function msgAuthor(m: Msg): string {
		return m.displayName ?? m.senderContactName ?? m.createdByName ?? 'Unknown';
	}


	// ── Estimated Revenue at Risk — Case.Estimated_Revenue_at_Risk__c ──
	$: revenueAtRisk = data.case.estimatedRevenueAtRisk ?? 0;
	// ── Store Total Saved — Store__c.Total_Revenue_Recovered__c ──
	$: storeTotalSaved = data.storeTotalSaved ?? 0;

	// ── Required-file rollup ──
	$: uploadedFiles = data.requiredFiles.filter((f) => f.uploaded);
	$: pendingFiles  = data.requiredFiles.filter((f) => !f.uploaded);


	$: isMine = (m: { senderContactId: string | null }) =>
		!!data.currentUser.sfdcContactId && data.currentUser.sfdcContactId === m.senderContactId;

	$: sortedMessages = [...data.messages].sort(
		(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
	);
	$: messageById = new Map(sortedMessages.map((m) => [m.Id, m]));
	function repliedMessage(m: Msg): Msg | null {
		return m.replyToMessageId ? (messageById.get(m.replyToMessageId) ?? null) : null;
	}
	function truncateBody(text: string, max = 80): string {
		const plain = text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
		return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
	}

	$: filteredMessages = (() => {
		const q = commentSearch.trim().toLowerCase();
		if (!q) return sortedMessages;
		return sortedMessages.filter((m) => {
			const author = (m.displayName ?? m.senderContactName ?? m.createdByName ?? '').toLowerCase();
			const body = (m.body ?? '').toLowerCase();
			return author.includes(q) || body.includes(q);
		});
	})();

	async function scrollCommentsToBottom(smooth = false) {
		await tick();
		if (!commentsListEl) return;
		commentsListEl.scrollTo({
			top: commentsListEl.scrollHeight,
			behavior: smooth ? 'smooth' : 'auto'
		});
	}

	onMount(() => {
		scrollCommentsToBottom();
	});

	$: messageCount = data.messages.length;
	$: messageCount, scrollCommentsToBottom();
</script>

<svelte:head><title>{data.case.CaseNumber} — Appeals Doctor</title></svelte:head>

<Topbar
	title={data.case.CaseNumber}
	subtitle={`${data.case.recordTypeName ?? 'Case'} · ${data.storeName}`}
>
	<a class="btn btn-outline btn-sm" href={`/stores/${data.storeId}`}>← Back to store</a>
</Topbar>

<div class="content-area">
	{#if form?.commentSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.commentSuccess}</div>{/if}
	{#if form?.revenueRiskSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.revenueRiskSuccess}</div>{/if}
	{#if form?.revenueRiskError}<div class="alert alert-error" style="margin-bottom:14px">{form.revenueRiskError}</div>{/if}
	{#if form?.uploadSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.uploadSuccess}</div>{/if}
	{#if form?.uploadError}<div class="alert alert-error" style="margin-bottom:14px">{form.uploadError}</div>{/if}

	<div class="case-detail-grid">
		<!-- ═══════════════════ LEFT COLUMN ═══════════════════ -->
		<div>
			<!-- ── Case Details card ────────────────────────────── -->
			<div class="card" style="margin-bottom:16px">
				<div class="card-title">
					Case Details
					<span class={`badge ${badgeClass(data.case.Status)}`}>{data.case.Status}</span>
				</div>
				<div class="fields-2col">
					<div class="field-block">
						<div class="field-label">Case ID</div>
						<div class="field-value mono">{data.case.CaseNumber}</div>
					</div>
					<div class="field-block">
						<div class="field-label">Service Type</div>
						<div class="field-value">{data.case.recordTypeName ?? '—'}</div>
					</div>
					<div class="field-block">
						<div class="field-label">Store</div>
						<div class="field-value">
							<a href={`/stores/${data.storeId}`}>{data.storeName}</a>
						</div>
					</div>
					<div class="field-block">
						<div class="field-label">Marketplace</div>
						<div class="field-value">
							{data.storeMarketplaces?.split(';').join(', ') ?? '—'}
						</div>
					</div>
					<div class="field-block">
						<div class="field-label">Opened On</div>
						<div class="field-value">{fmtDate(data.case.CreatedDate)}</div>
					</div>
					<div class="field-block">
						<div class="field-label">Priority</div>
						<div class="field-value">{data.case.Priority ?? '—'}</div>
					</div>
				</div>
				{#if isWaitingOnClient(data.case.Status) && pendingFiles.length > 0}
					<div class="alert alert-warn" style="margin-top:14px;margin-bottom:0">
						⚠️ Action required: Please upload the requested documents to proceed.
					</div>
				{/if}
			</div>

			<!-- ── Comments & Updates card ──────────────────────── -->
			<div class="card msg-card">
				<div class="msg-head">
					<h2 class="msg-title">Messages</h2>
				</div>

				{#if data.messagesError}
					<div class="alert alert-error" style="margin:10px 14px">{data.messagesError}</div>
				{/if}

				<div class="msg-search">
					<input
						type="search"
						class="comment-search"
						placeholder="Search messages…"
						bind:value={commentSearch}
						aria-label="Search messages"
					/>
				</div>

				<div class="msg-list" id="comments-list" bind:this={commentsListEl}>
					{#each filteredMessages as m (m.Id)}
						{@const mine = isMine(m)}
						{@const author = msgAuthor(m)}
						{@const internal = isInternal(m.senderType)}
						{@const parent = repliedMessage(m)}
						<div
							class="msg-row"
							class:internal
							class:unread={isUnread(m)}
							role="button"
							tabindex="0"
							title="Open message"
							on:click={() => openMessage(m)}
							on:keydown={(e) => {
								if (e.key === 'Enter' || e.key === ' ') {
									e.preventDefault();
									openMessage(m);
								}
							}}
						>
							<div class="msg-avatar" style="background:{avatarColor(m.senderType, mine)}">
								{initials(author)}
							</div>
							<div class="msg-content">
								<div class="msg-meta">
									<span class="msg-sender">{author}{mine ? ' (You)' : ''}</span>
									{#if internal}
										<span class="msg-badge badge-internal">Internal</span>
									{:else}
										<span class="msg-badge badge-external">External</span>
									{/if}
									<span class="msg-time">{fmtDateTime(m.createdAt)}</span>
									<button
										type="button"
										class="msg-reply-btn"
										data-mutates
										on:click|stopPropagation={() => startReply(m)}
									>
										↩ Reply
									</button>
								</div>
								{#if parent}
									<div class="msg-quote">
										<span class="msg-quote-author">{msgAuthor(parent)}</span>
										<span class="msg-quote-text">{truncateBody(parent.body ?? '')}</span>
									</div>
								{/if}
								<div class="msg-body">{@html m.body ?? ''}</div>
							</div>
						</div>
					{:else}
						<p class="comments-empty">
							{#if commentSearch.trim()}
								No messages match "{commentSearch.trim()}".
							{:else}
								No messages yet — start the conversation below.
							{/if}
						</p>
					{/each}
				</div>

				<form
					class="msg-composer"
					method="POST"
					action="?/post_comment"
					bind:this={composerFormEl}
					use:enhance={() => {
						posting = true;
						return ({ update, result }) => {
							posting = false;
							update().then(() => {
								if (result.type === 'success') {
									commentInput = '';
									replyingTo = null;
									scrollCommentsToBottom(true);
								}
							});
						};
					}}
				>
					{#if replyingTo}
						{@const parent = replyingTo}
						<div class="reply-preview">
							<div class="reply-preview-text">
								<span class="reply-preview-lbl">Replying to {msgAuthor(parent)}</span>
								<span class="reply-preview-body">{truncateBody(parent.body ?? '')}</span>
							</div>
							<button type="button" class="reply-preview-x" on:click={cancelReply} aria-label="Cancel reply">✕</button>
						</div>
					{/if}
					<RichTextEditor
						bind:value={commentInput}
						placeholder="Write a message…"
					/>
					<input type="hidden" name="body" value={commentInput} />
					<input type="hidden" name="replyToMessageId" value={replyingTo?.Id ?? ''} />
					<div class="composer-actions">
						<button type="submit" class="btn btn-primary btn-sm" disabled={posting}>
							{posting ? 'Sending…' : 'Send'}
						</button>
					</div>
					{#if form?.commentError}
						<div class="alert alert-error" style="margin-top:8px;margin-bottom:0">{form.commentError}</div>
					{/if}
				</form>
			</div>
		</div>

		<!-- ═══════════════════ RIGHT COLUMN (360px) ═══════════════════ -->
		<div>
			<!-- ── Financial card ─────────────────────────────────── -->
			<div class="fin-card">
				<div class="fin-label">Estimated Revenue at Risk</div>
				<div class="fin-amount">${revenueAtRisk.toLocaleString()}</div>
				<div class="fin-sub">Potential recovery if resolved successfully</div>
				<div class="fin-row">
					<div class="fin-item">
						<div class="fin-item-val">${storeTotalSaved.toLocaleString()}</div>
						<div class="fin-item-lbl">Store Total Saved</div>
					</div>
					<div class="fin-item">
						<div class="fin-item-val">{uploadedFiles.length}/{data.requiredFiles.length}</div>
						<div class="fin-item-lbl">Files Submitted</div>
					</div>
				</div>
				<div style="margin-top:14px;padding-top:12px;border-top:1px solid rgba(255,255,255,.1)">
					<div style="font-size:11px;color:rgba(255,255,255,.45);text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px">
						ASIN
					</div>
					{#if data.case.asin}
						<div style="font-family:ui-monospace,monospace;font-size:13px;margin-bottom:10px">{data.case.asin}</div>
					{:else}
						<div style="font-size:12px;color:rgba(255,255,255,.5);margin-bottom:10px">Not set on this case</div>
					{/if}
					<form
						method="POST"
						action="?/recalculate_revenue_at_risk"
						use:enhance={() => {
							recalculating = true;
							return async ({ update }) => {
								await update();
								recalculating = false;
							};
						}}
					>
						<button
							class="btn-sm btn-outline"
							type="submit"
							disabled={recalculating || !data.case.asin}
							style="display:none;width:100%;color:white;border-color:rgba(255,255,255,.3)"
						>
							{recalculating ? 'Recalculating…' : 'Recalculate from Amazon sales'}
						</button>
					</form>
				</div>
			</div>

			<CaseTimeline events={data.timeline} historyError={data.historyError} />

			<!-- ── Case Documents card (required-file checklist) ── -->
			<div class="card" style="margin-bottom:14px">
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
						buildDownloadUrl={(docId) => `/api/cases/${data.case.Id}/documents/${docId}`}
						uploadError={form?.uploadError ?? null}
					/>
				{/if}
			</div>
		</div>
	</div>
</div>

{#if showMessageModal && selectedMessage}
	{@const m = selectedMessage}
	{@const mine = isMine(m)}
	{@const author = msgAuthor(m)}
	{@const internal = isInternal(m.senderType)}
	<div class="msg-modal-overlay" on:click={closeMessage} role="presentation">
		<div
			class="msg-modal"
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
			aria-label="Message"
			tabindex="-1"
		>
			<header class="msg-modal-head">
				<h3>Message</h3>
				<button type="button" class="msg-modal-x" on:click={closeMessage} aria-label="Close">✕</button>
			</header>
			<div class="msg-modal-body">
				<div class="msg-modal-meta">
					<div class="msg-avatar lg" style="background:{avatarColor(m.senderType, mine)}">
						{initials(author)}
					</div>
					<div>
						<div class="msg-meta">
							<span class="msg-sender">{author}{mine ? ' (You)' : ''}</span>
							{#if internal}
								<span class="msg-badge badge-internal">Internal</span>
							{:else}
								<span class="msg-badge badge-external">External</span>
							{/if}
						</div>
						<div class="msg-time">{fmtDateTime(m.createdAt)}</div>
					</div>
				</div>
				<div class="msg-modal-text">{@html m.body ?? ''}</div>
			</div>
			<footer class="msg-modal-foot">
				<button type="button" class="btn btn-outline btn-sm" on:click={closeMessage}>Close</button>
				<button type="button" class="btn btn-primary btn-sm" data-mutates on:click={() => startReply(m)}>↩ Reply</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.file-link {
		background: none;
		border: none;
		padding: 0;
		color: var(--orange, #ea580c);
		font: inherit;
		text-decoration: underline;
		cursor: pointer;
	}
	.file-icn { width: 22px; height: 22px; object-fit: contain; display: block; }
	/* Color tokens — defaults match the mockup; override at root if your
	   global stylesheet defines different palette variables. */
	:global(:root) {
		--orange-dk: #c47a00;
	}

	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }

	/* ── Two-column grid (from mockup) ───────────────────────── */
	.case-detail-grid {
		display: grid; grid-template-columns: 1fr 360px;
		gap: 20px; align-items: start;
	}

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

	/* Field grid */
	.fields-2col {
		display: grid; grid-template-columns: 1fr 1fr;
		gap: 14px 20px;
	}
	.field-block { margin-bottom: 0; }
	.field-label {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text); margin-bottom: 3px;
	}
	.field-value { font-size: 14px; font-weight: 500; }
	.field-value.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px;
	}

	/* ── Record links — plain links, matches the payment detail page ── */
	.field-value a { color: var(--orange); text-decoration: none; }
	.field-value a:hover { text-decoration: underline; }

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
	.link-badge { border: none; cursor: pointer; }
	.link-badge:hover { background: #d1d5db; }

	/* ── Comments (mockup classes) ───────────────────────────── */
	/* ── Messages card (LWC-style, app colors) ───────────────── */
	.msg-card {
		display: flex;
		flex-direction: column;
		height: 520px;
		padding: 0;
		overflow: hidden;
	}
	.msg-head {
		padding: 12px 14px;
		border-bottom: 1px solid var(--grey-line);
		flex-shrink: 0;
	}
	.msg-title { font-size: 14px; font-weight: 800; color: var(--navy); margin: 0; }
	.msg-search {
		padding: 10px 14px;
		border-bottom: 1px solid var(--grey-line);
		flex-shrink: 0;
	}
	.comment-search {
		width: 100%; box-sizing: border-box;
		border: 1.5px solid var(--grey-line); border-radius: 9px;
		padding: 8px 12px; font-size: 13px; outline: none;
		transition: border-color .2s; font-family: inherit;
	}
	.comment-search:focus { border-color: var(--orange); }

	.msg-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 0; }
	.comments-empty {
		color: var(--grey-text); font-size: 13px; margin: 0;
		padding: 16px; text-align: center;
	}

	.msg-row {
		display: flex; gap: 10px; align-items: flex-start;
		padding: 8px 14px; cursor: pointer;
		transition: background-color .15s;
	}
	.msg-row:hover, .msg-row:focus { background: var(--grey-bg); outline: none; }
	.msg-row.internal { background: rgba(27, 43, 75, .035); }
	.msg-row.internal:hover, .msg-row.internal:focus { background: var(--grey-bg); }

	/* Unread messages — highlighted, fading back to normal over ~5s once read. */
	.msg-row.unread {
		background: #fff7e0;
		transition: background-color 5s ease;
	}
	.msg-row.unread:hover, .msg-row.unread:focus { background: #fdecc4; }

	.msg-reply-btn {
		margin-left: auto; background: none; border: none; cursor: pointer;
		font-size: 11px; font-weight: 600; color: var(--grey-text);
		padding: 1px 4px; border-radius: 5px; opacity: 0; transition: opacity .12s, color .12s;
	}
	.msg-row:hover .msg-reply-btn, .msg-row:focus-within .msg-reply-btn { opacity: 1; }
	.msg-reply-btn:hover { color: var(--orange); }

	.msg-quote {
		display: flex; gap: 6px; align-items: baseline; margin-bottom: 3px;
		padding-left: 8px; border-left: 2px solid var(--grey-line);
		font-size: 11px; color: var(--grey-text); overflow: hidden;
	}
	.msg-quote-author { font-weight: 700; flex-shrink: 0; }
	.msg-quote-text { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

	.msg-avatar {
		width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0; margin-top: 1px;
		display: flex; align-items: center; justify-content: center;
		font-size: 11px; font-weight: 700; color: #fff;
	}
	.msg-avatar.lg { width: 38px; height: 38px; font-size: 13px; }

	.msg-content { min-width: 0; flex: 1; }
	.msg-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; margin-bottom: 2px; }
	.msg-sender { font-size: 13px; font-weight: 700; color: var(--navy); }
	.msg-time { font-size: 11px; color: var(--grey-text); white-space: nowrap; }
	.msg-badge {
		font-size: 10px; font-weight: 700; line-height: 1;
		padding: 2px 6px; border-radius: 10px;
		text-transform: uppercase; letter-spacing: .03em;
	}
	.badge-internal { background: rgba(27, 43, 75, .10); color: var(--navy); }
	.badge-external { background: var(--blue-lt); color: var(--blue); }
	.msg-body {
		font-size: 13px; line-height: 1.4; color: var(--navy-dark);
		word-break: break-word; white-space: normal;
	}
	.msg-body :global(ul), .msg-body :global(ol) {
		margin: 4px 0; padding-left: 22px;
	}

	.msg-composer {
		flex-shrink: 0; border-top: 1px solid var(--grey-line);
		padding: 10px 14px 12px;
	}
	.reply-preview {
		display: flex; align-items: center; gap: 8px;
		background: var(--grey-bg); border-left: 3px solid var(--orange);
		border-radius: 6px; padding: 6px 10px; margin-bottom: 8px;
	}
	.reply-preview-text { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 1px; }
	.reply-preview-lbl { font-size: 11px; font-weight: 700; color: var(--orange-dk, var(--orange)); }
	.reply-preview-body {
		font-size: 12px; color: var(--grey-text);
		white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
	}
	.reply-preview-x {
		background: none; border: none; cursor: pointer; color: var(--grey-text);
		font-size: 13px; flex-shrink: 0; padding: 2px 4px;
	}
	.reply-preview-x:hover { color: #b91c1c; }
	.comment-box {
		width: 100%; box-sizing: border-box;
		border: 1.5px solid var(--grey-line); border-radius: 9px;
		padding: 10px 13px; font-size: 13px; resize: none; height: 64px;
		outline: none; transition: border-color .2s; font-family: inherit;
	}
	.comment-box:focus { border-color: var(--orange); }
	.composer-actions { display: flex; justify-content: flex-end; margin-top: 8px; }

	/* ── Message detail modal ────────────────────────────────── */
	.msg-modal-overlay {
		position: fixed; inset: 0; background: rgba(15, 23, 42, .55);
		display: flex; align-items: center; justify-content: center;
		z-index: 1000; padding: 24px;
	}
	.msg-modal {
		background: #fff; border-radius: 12px; width: min(560px, 100%);
		max-height: 85vh; display: flex; flex-direction: column;
		overflow: hidden; box-shadow: var(--shadow-xl);
	}
	.msg-modal-head {
		display: flex; align-items: center; justify-content: space-between;
		padding: 14px 18px; border-bottom: 1px solid var(--grey-line);
	}
	.msg-modal-head h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy); }
	.msg-modal-x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); line-height: 1; }
	.msg-modal-body { padding: 18px; overflow: auto; }
	.msg-modal-meta { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 14px; }
	.msg-modal-text {
		font-size: 14px; line-height: 1.5; color: var(--navy-dark);
		white-space: pre-wrap; word-break: break-word;
		border-top: 1px solid var(--grey-line); padding-top: 14px;
	}
	.msg-modal-text :global(ul), .msg-modal-text :global(ol) {
		margin: 4px 0; padding-left: 22px;
	}
	.msg-modal-foot { padding: 12px 18px; border-top: 1px solid var(--grey-line); display: flex; justify-content: flex-end; gap: 8px; }

	/* ── Financial card ──────────────────────────────────────── */
	.fin-card {
		background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
		border-radius: var(--radius); padding: 18px;
		color: white; margin-bottom: 14px;
	}
	.fin-label { font-size: 11px; color: rgba(255,255,255,.55); margin-bottom: 4px; }
	.fin-amount { font-size: 30px; font-weight: 800; color: var(--orange); }
	.fin-sub { font-size: 11px; color: rgba(255,255,255,.4); margin-top: 3px; }
	.fin-row {
		display: flex; gap: 14px; margin-top: 12px; padding-top: 12px;
		border-top: 1px solid rgba(255,255,255,.1);
	}
	.fin-item { flex: 1; text-align: center; }
	.fin-item-val { font-size: 16px; font-weight: 700; }
	.fin-item-lbl {
		font-size: 10px; color: rgba(255,255,255,.45); text-transform: uppercase;
		letter-spacing: .04em; margin-top: 2px;
	}

	/* ── Documents (mockup-style doc-item) ───────────────────── */
	.doc-item {
		display: flex; align-items: center; gap: 10px;
		padding: 10px 12px; border: 1px solid var(--grey-line);
		border-radius: 9px; margin-bottom: 8px;
		transition: all .2s;
	}
	.doc-item:hover { border-color: var(--orange); background: var(--orange-lt, #fff5ec); }
	.doc-icon { font-size: 22px; flex-shrink: 0; }
	.doc-info { flex: 1; min-width: 0; }
	.doc-name { font-size: 13px; font-weight: 600; }
	.doc-name a { color: var(--navy); text-decoration: none; }
	.doc-name a:hover { color: var(--orange); }
	.doc-meta { font-size: 11px; color: var(--grey-text); }

	.upload-zone {
		display: block; width: 100%; box-sizing: border-box;
		border: 2px dashed var(--grey-line); border-radius: 9px;
		padding: 16px; text-align: center; font-size: 13px;
		color: var(--grey-text); cursor: pointer;
		transition: all .2s; margin-top: 10px;
		background: transparent; font-family: inherit;
	}
	.upload-zone:hover {
		border-color: var(--orange); color: var(--orange);
		background: var(--orange-lt, #fff5ec);
	}

	/* ── Buttons (mockup small variants) ─────────────────────── */
	.btn-sm {
		padding: 5px 12px; font-size: 12px; font-weight: 600;
		border-radius: 7px; border: 1px solid transparent; cursor: pointer;
	}
	.btn-orange {
		background: var(--orange); color: white; border-color: var(--orange);
	}
	.btn-orange:hover:not(:disabled) { background: var(--orange-dk); }
	.btn-orange:disabled { opacity: .55; cursor: not-allowed; }
	.btn-nav {
		background: white; color: var(--navy); border-color: var(--grey-line);
	}
	.btn-nav:hover:not(:disabled) { background: #f3f4f6; }

	/* ── Alerts (mockup) ─────────────────────────────────────── */
	.alert {
		border-radius: 9px; padding: 12px 16px; font-size: 13px;
	}
	.alert-info { background: #dbeafe; border: 1px solid #93c5fd; color: #1e40af; }
	.alert-warn { background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; }
	.alert-success { background: #d1fae5; border: 1px solid #86efac; color: #166534; }
	.alert-error { background: #fee2e2; border: 1px solid #fca5a5; color: #b91c1c; }

	/* ── Upload modal (mockup) ───────────────────────────────── */
	.modal-overlay {
		display: none; position: fixed; inset: 0;
		background: rgba(17, 29, 51, .6); backdrop-filter: blur(4px);
		z-index: 1000; align-items: center; justify-content: center; padding: 24px;
	}
	.modal-overlay.open { display: flex; }
	.modal-box {
		background: white; border-radius: 18px;
		width: 100%; max-height: 90vh; overflow-y: auto;
		box-shadow: 0 24px 80px rgba(0,0,0,.3);
		animation: mIn .2s ease;
	}
	.modal-box.md { max-width: 600px; }
	@keyframes mIn { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: scale(1); } }
	.modal-hdr {
		padding: 20px 24px 16px; border-bottom: 1px solid var(--grey-line);
		display: flex; align-items: center; justify-content: space-between;
	}
	.modal-hdr h3 { font-size: 16px; font-weight: 700; margin: 0; }
	.modal-x {
		background: #f3f4f6; border: none; width: 28px; height: 28px;
		border-radius: 50%; font-size: 15px; cursor: pointer;
		display: flex; align-items: center; justify-content: center;
	}
	.modal-x:hover { background: var(--grey-line); }
	.modal-body { padding: 22px 24px; }

	.upload-modal-zone {
		border: 2px dashed var(--grey-line); border-radius: 12px;
		padding: 32px 20px; text-align: center; cursor: pointer;
		transition: all .25s; margin-bottom: 18px;
	}
	.upload-modal-zone:hover,
	.upload-modal-zone.drag-over {
		border-color: var(--orange); background: var(--orange-lt, #fff5ec);
	}
	.uz-icon {
		width: 56px; height: 56px; margin: 0 auto 12px;
		background: var(--navy-dark); border-radius: 14px;
		display: flex; align-items: center; justify-content: center;
	}
	.uz-icon img { width: 28px; height: 28px; object-fit: contain; }
	.uz-title { font-size: 15px; font-weight: 700; color: var(--navy); margin-bottom: 4px; }
	.uz-sub { font-size: 13px; color: var(--grey-text); }

	.file-type-grid {
		display: grid; grid-template-columns: repeat(3, 1fr);
		gap: 8px; margin-bottom: 18px;
	}
	.file-type-item {
		background: #f3f4f6; border-radius: 8px; padding: 9px 10px; text-align: center;
	}
	.ft-icon { height: 28px; margin-bottom: 4px; display: flex; align-items: center; justify-content: center; }
	.ft-icon img { width: 26px; height: 26px; object-fit: contain; }
	.ft-label { font-size: 11px; font-weight: 700; color: var(--navy); }
	.ft-desc { font-size: 10px; color: var(--grey-text); }

	.guidelines {
		background: #f3f4f6; border-radius: 10px;
		padding: 14px 16px; margin-bottom: 18px; font-size: 13px;
	}
	.guidelines-hdr {
		display: flex; align-items: center; gap: 8px;
		font-weight: 700; margin-bottom: 10px; color: var(--navy);
	}
	.g-badge {
		width: 28px; height: 28px; flex-shrink: 0;
		background: var(--navy-dark); border-radius: 8px;
		display: flex; align-items: center; justify-content: center;
	}
	.g-badge img { width: 16px; height: 16px; object-fit: contain; }
	.guidelines ul {
		padding-left: 16px; color: var(--grey-text); line-height: 1.9; margin: 0;
	}

	/* ── Required-file slot rows ─────────────────────────────── */
	.doc-item.slot { align-items: flex-start; padding: 12px 14px; }
	.doc-item.slot .doc-name { color: var(--navy); }
	.doc-item.slot.slot-uploaded { background: #f0fdf4; border-color: #bbf7d0; }
	.doc-item.slot.slot-uploaded:hover { background: #dcfce7; }
	.doc-desc {
		font-size: 12px; color: var(--grey-text); line-height: 1.45;
		margin-top: 2px;
	}
	.doc-meta a { color: var(--orange); text-decoration: none; }
	.doc-meta a:hover { text-decoration: underline; }
	.doc-meta.mono {
		font-family: ui-monospace, monospace; font-size: 11px;
		word-break: break-all;
	}
	.slot-right {
		display: flex; flex-direction: column; align-items: flex-end;
		gap: 6px; flex-shrink: 0; margin-left: 8px;
	}
	.link-x {
		background: none; border: none; color: var(--grey-text);
		font-size: 14px; cursor: pointer; padding: 2px 6px;
	}
	.link-x:hover { color: #b91c1c; }

	/* Slot context inside the upload modal */
	.slot-context {
		background: #f9fafb; border: 1px solid var(--grey-line);
		border-radius: 10px; padding: 12px 14px; margin-bottom: 16px;
	}
	.slot-context-label {
		font-size: 10px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: var(--grey-text); margin-bottom: 4px;
	}
	.slot-context-name { font-size: 14px; font-weight: 600; color: var(--navy); }
</style>
