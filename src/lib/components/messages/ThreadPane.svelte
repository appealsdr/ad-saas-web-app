<script lang="ts">
	/**
	 * Slack-style thread side pane: the full reply history of one message plus a
	 * composer that replies to the thread. Opened from "Reply" in the conversation.
	 * Posts through the same form action as the main composer, with the thread
	 * root as Reply_To_Message__c (the server re-validates it is in this
	 * conversation).
	 */
	import { enhance } from '$app/forms';
	import { createEventDispatcher, tick } from 'svelte';
	import RichTextEditor from '$components/ui/RichTextEditor.svelte';
	import type { AppMessage, ConversationData } from '$lib/types/app-message';
	import { threadFor, initials, isInternalSender } from './conversation-utils';

	export let conversation: ConversationData;
	export let rootId: string;
	export let postAction = '?/post_message';

	const dispatch = createEventDispatcher<{ close: void }>();

	let input = '';
	let posting = false;
	let error: string | null = null;
	let listEl: HTMLDivElement;
	let formEl: HTMLFormElement;
	let closeBtn: HTMLButtonElement;

	$: thread = threadFor(conversation.messages, rootId);
	$: contactId = conversation.currentContactId;
	$: replyCount = thread?.replies.length ?? 0;
	$: replyCount, scrollToEnd();

	const isMine = (m: AppMessage) => !!contactId && contactId === m.senderContactId;
	const author = (m: AppMessage) => m.displayName ?? m.senderContactName ?? m.createdByName ?? 'Unknown';
	const color = (m: AppMessage) =>
		isMine(m) ? 'var(--green, #15803d)' : isInternalSender(m.senderType) ? 'var(--navy-soft, #2a3f6f)' : 'var(--blue, #2563eb)';
	function when(iso: string): string {
		try {
			const d = new Date(iso);
			return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} · ${d
				.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
				.toLowerCase()}`;
		} catch {
			return iso;
		}
	}
	async function scrollToEnd() {
		await tick();
		listEl?.scrollTo({ top: listEl.scrollHeight });
	}
	function sendFromKeyboard() {
		if (posting || !input.replace(/<[^>]*>|&nbsp;|\s/g, '')) return;
		formEl?.requestSubmit();
	}
	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') dispatch('close');
	}
</script>

<svelte:window on:keydown={onKeydown} />

<aside class="thread" aria-label="Thread">
	<header class="th-head">
		<div class="th-title">
			<h2>Thread</h2>
			{#if thread}<span class="th-sub">{replyCount} {replyCount === 1 ? 'reply' : 'replies'}</span>{/if}
		</div>
		<button type="button" class="th-close" bind:this={closeBtn} on:click={() => dispatch('close')} aria-label="Close thread">✕</button>
	</header>

	{#if !thread}
		<div class="th-empty" role="note">This message is no longer available.</div>
	{:else}
		<div class="th-list" bind:this={listEl} role="log" aria-label="Thread messages">
			{#each [thread.root, ...thread.replies] as m, i (m.Id)}
				{#if i === 1}
					<div class="th-divider" role="separator"><span>{replyCount} {replyCount === 1 ? 'reply' : 'replies'}</span></div>
				{/if}
				<div class="th-row" class:root={i === 0}>
					<div class="th-avatar" style="background:{color(m)}" aria-hidden="true">{initials(author(m))}</div>
					<div class="th-content">
						<div class="th-meta">
							<span class="th-sender">{author(m)}{isMine(m) ? ' (You)' : ''}</span>
							<span class="th-badge" class:team={isInternalSender(m.senderType)}>{isInternalSender(m.senderType) ? 'Team' : 'Client'}</span>
							<time class="th-time" datetime={m.createdAt}>{when(m.createdAt)}</time>
						</div>
						<div class="th-body">{@html m.body ?? ''}</div>
					</div>
				</div>
			{/each}
		</div>

		<form
			class="th-composer"
			method="POST"
			action={postAction}
			bind:this={formEl}
			use:enhance={() => {
				posting = true;
				error = null;
				return async ({ result, update }) => {
					posting = false;
					if (result.type === 'failure') {
						error = (result.data as { messageError?: string } | undefined)?.messageError ?? 'Could not send the reply.';
						return;
					}
					if (result.type === 'success') input = '';
					await update({ reset: false });
				};
			}}
		>
			{#if !conversation.canSend && conversation.sendDisabledReason}
				<div class="alert alert-warn" role="note">{conversation.sendDisabledReason}</div>
			{:else}
				<RichTextEditor bind:value={input} placeholder="Reply…" submitOnEnter on:submit={sendFromKeyboard}>
					<svelte:fragment slot="actions">
						<span class="th-hint"><b>Enter</b> to send</span>
						<button type="submit" class="th-send" disabled={posting} aria-label="Send reply">{posting ? 'Sending…' : 'Reply'}</button>
					</svelte:fragment>
				</RichTextEditor>
				<input type="hidden" name="body" value={input} />
				<input type="hidden" name="replyToMessageId" value={thread.root.Id} />
			{/if}
			{#if error}<div class="alert alert-error th-error" role="alert">{error}</div>{/if}
		</form>
	{/if}
</aside>

<style>
	.thread { display: flex; flex-direction: column; min-height: 0; background: #fff; border-left: 1px solid var(--grey-line, #e0e6ef); }
	.th-head { display: flex; align-items: center; gap: 10px; min-height: 52px; box-sizing: border-box; padding: 6px 16px 6px 18px; border-bottom: 1px solid var(--grey-line, #e0e6ef); flex-shrink: 0; }
	.th-title { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
	.th-title h2 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy, #1b2b4b); }
	.th-sub { font-size: 12px; color: var(--grey-text, #5a6886); }
	.th-close { background: none; border: 0; cursor: pointer; font-size: 16px; color: var(--grey-text, #5a6886); min-width: 32px; min-height: 32px; border-radius: 6px; }
	.th-close:hover { background: var(--grey-bg, #f6f8fb); }
	.th-close:focus-visible { outline: 2px solid var(--orange, #f5a100); }
	.th-empty { padding: 20px; font-size: 13px; color: var(--grey-text, #5a6886); }
	.th-list { flex: 1; min-height: 0; overflow-y: auto; padding: 8px 0; }
	.th-divider { display: flex; align-items: center; gap: 10px; padding: 6px 18px; font-size: 12px; font-weight: 600; color: var(--grey-text, #5a6886); }
	.th-divider::before, .th-divider::after { content: ''; flex: 1; height: 1px; background: var(--grey-line, #e0e6ef); }
	.th-row { display: flex; gap: 10px; padding: 6px 18px; }
	.th-row.root { background: var(--grey-bg, #f6f8fb); padding-top: 10px; padding-bottom: 10px; }
	.th-avatar { width: 32px; height: 32px; border-radius: 8px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; }
	.th-content { min-width: 0; flex: 1; }
	.th-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
	.th-sender { font-size: 13px; font-weight: 700; color: var(--navy, #1b2b4b); }
	.th-time { font-size: 11px; color: var(--grey-text, #5a6886); }
	.th-badge { font-size: 10px; font-weight: 700; line-height: 1; padding: 2px 6px; border-radius: 4px; background: #fff4dc; border: 1px solid #f5a100; color: var(--navy, #1b2b4b); }
	.th-badge.team { background: #e0e6ef; border-color: transparent; }
	.th-body { font-size: 14px; line-height: 1.35; color: var(--navy-dark, #111d33); word-break: break-word; }
	.th-body :global(p) { margin: 0; }
	.th-body :global(ul), .th-body :global(ol) { margin: 4px 0; padding-left: 22px; }
	.th-composer { flex-shrink: 0; padding: 4px 16px 12px; }
	.th-composer :global(.rte) { border: 1px solid #c9d3e6; border-radius: 10px; }
	.th-composer :global(.rte:focus-within) { border-color: var(--orange, #f5a100); }
	.th-composer :global(.rte-editor) { min-height: 64px; max-height: 180px; font-size: 14px; padding: 10px 12px; }
	.th-hint { font-size: 11px; color: var(--grey-text, #5a6886); }
	.th-send { margin-left: auto; border: 0; border-radius: 8px; background: var(--orange, #f5a100); color: #1b2b4b; font-weight: 700; font-size: 13px; padding: 7px 16px; min-height: 32px; cursor: pointer; }
	.th-send:hover:not(:disabled) { background: var(--orange-dk, #d98c00); }
	.th-send:disabled { opacity: .6; cursor: not-allowed; }
	.th-error { margin: 8px 0 0; }
</style>
