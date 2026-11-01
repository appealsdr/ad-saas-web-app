<script lang="ts">
	import { enhance } from '$app/forms';
	import Topbar from '$components/layout/Topbar.svelte';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	let question = '';
	let provider: 'claude' | 'gemini' = 'claude';
	let answerStyle: 'balanced' | 'short' | 'detailed' = 'balanced';
	let sending = false;
	let formEl: HTMLFormElement;

	// Enter sends the message; Shift+Enter still inserts a newline.
	function handleComposerKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			if (!sending && question.trim()) formEl.requestSubmit();
		}
	}

	function fmtTime(iso: string) {
		try { return new Date(iso).toLocaleString(); } catch { return iso; }
	}

	const quickPrompts = [
		'Explain my last Amazon email',
		'What am I missing for my appeal?',
		'Is my plan enough?'
	];
	function useQuickPrompt(p: string) {
		question = p;
	}
</script>

<svelte:head><title>Ask about your store — Appeals Doctor</title></svelte:head>

<Topbar title="Ask about your store" subtitle={`${data.store.name} · answers use your cases, documents and plan`}>
	<a class="btn btn-outline btn-sm" href={`/stores/${data.store.id}`}>← Back to store</a>
</Topbar>

<div class="chat-layout">
	<div class="content-area">
		<div class="thread">
			{#if data.messages.length === 0}
				<div class="empty">No messages yet — ask something below to start the conversation.</div>
			{/if}
			{#each data.messages as m (m.id)}
				<div class="msg-pair">
					<div class="bubble question">
						<div class="bubble-meta">You · {fmtTime(m.createdAt)}</div>
						{m.question}
					</div>
					{#if m.status === 'answered'}
						<div class="bubble answer">
							<div class="bubble-meta">{m.provider === 'claude' ? 'Claude' : 'Gemini'}</div>
							{m.answer}
						</div>
					{:else if m.status === 'failed'}
						<div class="bubble answer failed">
							<div class="bubble-meta">{m.provider === 'claude' ? 'Claude' : 'Gemini'} — error</div>
							{m.errorMessage ?? 'Could not answer.'}
						</div>
					{:else}
						<div class="bubble answer pending">Thinking…</div>
					{/if}
				</div>
			{/each}
		</div>

		{#if form?.error}
			<div class="form-error">{form.error}</div>
		{/if}

		<div class="quick-prompts">
			{#each quickPrompts as p}
				<button type="button" class="chip" on:click={() => useQuickPrompt(p)}>{p}</button>
			{/each}
		</div>

		<form
			method="POST"
			action="?/send_message"
			class="composer"
			bind:this={formEl}
			use:enhance={() => {
				sending = true;
				return async ({ update }) => {
					await update();
					sending = false;
					question = '';
				};
			}}
		>
			<select name="provider" bind:value={provider} class="form-control provider-select">
				<option value="claude">Claude</option>
				<option value="gemini">Gemini</option>
			</select>
			<textarea
				name="question"
				class="form-control question-input"
				placeholder="Ask a question… (Enter to send, Shift+Enter for a new line)"
				bind:value={question}
				on:keydown={handleComposerKeydown}
				rows="2"
				required
			></textarea>
			<button class="btn btn-primary" type="submit" disabled={sending || !question.trim()}>
				{sending ? 'Sending…' : 'Send'}
			</button>
		</form>
		<div class="answer-style-row">
			<span>Answer style:</span>
			<button type="button" class="style-opt" class:active={answerStyle === 'balanced'} on:click={() => (answerStyle = 'balanced')}>Balanced</button>
			<button type="button" class="style-opt" class:active={answerStyle === 'short'} on:click={() => (answerStyle = 'short')}>Short</button>
			<button type="button" class="style-opt" class:active={answerStyle === 'detailed'} on:click={() => (answerStyle = 'detailed')}>Detailed</button>
			<span class="style-hint">— nothing you write here is sent to Amazon.</span>
		</div>
	</div>

	<aside class="rail">
		<div class="rail-section">
			<div class="rail-title">What it can help with</div>
			<ul class="rail-list good">
				<li>Explaining an Amazon notice in plain words</li>
				<li>Telling you what a case is waiting on</li>
				<li>Drafting wording for an appeal</li>
				<li>Checking a document before you send it</li>
			</ul>
		</div>
		<div class="rail-section">
			<div class="rail-title">What it can't do</div>
			<ul class="rail-list bad">
				<li>Contact Amazon or file anything for you</li>
				<li>Promise your account will be reinstated</li>
				<li>Give legal advice</li>
			</ul>
		</div>
		<div class="rail-footer">
			Included in your plan. Unlimited questions for this store.
			<a href="mailto:support@appealsdoctor.com" class="human-link">Talk to a human instead →</a>
		</div>
	</aside>
</div>

<style>
	.chat-layout { flex: 1; display: flex; overflow: hidden; }

	.content-area {
		flex: 1; min-width: 0; overflow-y: auto; padding: 22px 26px;
		display: flex; flex-direction: column;
	}

	.thread { flex: 1; display: flex; flex-direction: column; gap: 18px; margin-bottom: 18px; }
	.empty {
		background: white; border: 1px dashed var(--grey-line);
		border-radius: var(--radius); padding: 26px;
		font-size: 14px; color: var(--grey-text); line-height: 1.5;
	}

	.msg-pair { display: flex; flex-direction: column; gap: 8px; max-width: 720px; }
	.bubble {
		border-radius: var(--radius); padding: 10px 14px; font-size: 14px; line-height: 1.5;
		white-space: pre-wrap;
	}
	.bubble-meta { font-size: 11px; color: var(--grey-text); margin-bottom: 4px; font-weight: 600; }
	.bubble.question { background: #fff5ec; align-self: flex-end; }
	.bubble.answer { background: white; border: 1px solid var(--grey-line); align-self: flex-start; }
	.bubble.answer.failed { border-color: #d33; color: #a00; }
	.bubble.answer.pending { color: var(--grey-text); font-style: italic; }

	.form-error {
		background: #fdecea; color: #a00; border: 1px solid #f5c2c0;
		border-radius: var(--radius); padding: 10px 14px; font-size: 13px; margin-bottom: 14px;
	}

	.quick-prompts { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; }
	.chip {
		border: 1px solid var(--grey-line); background: white; color: var(--navy);
		border-radius: 999px; padding: 6px 12px; font-size: 12px; cursor: pointer;
	}
	.chip:hover { border-color: var(--orange); }

	.composer {
		background: white; border: 1px solid var(--grey-line); border-radius: var(--radius);
		padding: 12px; display: flex; gap: 10px; align-items: flex-end;
	}
	.provider-select { width: 120px; flex-shrink: 0; }
	.question-input { flex: 1; resize: none; }

	.answer-style-row {
		display: flex; align-items: center; gap: 8px; margin-top: 10px;
		font-size: 12px; color: var(--grey-text);
	}
	.style-opt {
		border: 1px solid var(--grey-line); background: white; color: var(--grey-text);
		border-radius: 999px; padding: 3px 10px; font-size: 11px; cursor: pointer;
	}
	.style-opt.active { background: var(--navy); border-color: var(--navy); color: white; }
	.style-hint { margin-left: 4px; }

	.rail {
		width: 260px; flex-shrink: 0; overflow-y: auto;
		background: white; border-left: 1px solid var(--grey-line);
		padding: 22px 20px; display: flex; flex-direction: column; gap: 22px;
	}
	.rail-title {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .04em; color: var(--grey-text); margin-bottom: 8px;
	}
	.rail-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: 12px; line-height: 1.4; }
	.rail-list li { padding-left: 18px; position: relative; }
	.rail-list.good li::before { content: '✓'; position: absolute; left: 0; color: var(--green); font-weight: 700; }
	.rail-list.bad li::before { content: '✕'; position: absolute; left: 0; color: var(--red); font-weight: 700; }
	.rail-footer { font-size: 11px; color: var(--grey-text); line-height: 1.5; border-top: 1px solid var(--grey-line); padding-top: 16px; }
	.human-link { display: block; margin-top: 8px; color: var(--orange-dk); font-weight: 600; text-decoration: none; }
	.human-link:hover { text-decoration: underline; }
</style>
