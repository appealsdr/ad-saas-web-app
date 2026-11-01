<script lang="ts">
	import Topbar from '$components/layout/Topbar.svelte';
	import type { PageData } from './$types';

	export let data: PageData;

	// Presentational only for now — each card's primary action opens the real
	// chat. We'll decide what (if anything) becomes bespoke per-assistant
	// behavior later.
	const assistants = [
		{
			name: 'Appeal Writer',
			included: true,
			body: 'Turns the notice Amazon sent you into a first-draft Plan of Action, in the structure Amazon expects.',
			cta: 'Write a draft'
		},
		{
			name: 'Document Checker',
			included: true,
			body: 'Reads the invoices and letters you upload and tells you which ones Amazon will reject, before you send them.',
			cta: 'Check my documents'
		},
		{
			name: 'Account Health Watch',
			included: false,
			body: 'Checks your account every morning and messages you the moment something starts trending the wrong way.',
			cta: 'Unlock with Enterprise'
		},
		{
			name: 'Policy Explainer',
			included: true,
			body: 'Ask anything about Amazon’s rules in normal words and get an answer with the policy it came from.',
			cta: 'Ask a question'
		}
	];
</script>

<svelte:head><title>AI Assistants — Appeals Doctor</title></svelte:head>

<Topbar
	title="AI assistants"
	subtitle={`${data.store.name} · they draft and check things for you. A human still reviews anything we file.`}
>
	<a class="btn btn-outline btn-sm" href={`/stores/${data.store.id}`}>← Back to store</a>
</Topbar>

<div class="content-area">
	<div class="assistants-grid">
		{#each assistants as a (a.name)}
			<div class="assistant-card" class:locked={!a.included}>
				<div class="assistant-hdr">
					<div class="assistant-name">{a.name}</div>
					<span class="assistant-badge" class:locked={!a.included}>
						{a.included ? 'Included in your plan' : 'Enterprise only'}
					</span>
				</div>
				<p class="assistant-body">{a.body}</p>
				<a
					class="btn {a.included ? 'btn-primary' : 'btn-outline'} btn-sm"
					href={`/stores/${data.store.id}/chat`}
				>
					{a.cta}
				</a>
			</div>
		{/each}
	</div>

	<div class="disclaimer">
		What these assistants never do: file anything with Amazon on their own, contact buyers, or
		change your listings. Everything they produce is a draft for you to approve.
	</div>
</div>

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }

	.assistants-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }

	.assistant-card {
		background: white; border: 1px solid var(--grey-line); border-radius: var(--radius);
		padding: 20px; display: flex; flex-direction: column; gap: 10px;
	}
	.assistant-card.locked { background: var(--grey-bg); }

	.assistant-hdr { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
	.assistant-name { font-size: 15px; font-weight: 700; color: var(--navy); }
	.assistant-badge {
		font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em;
		background: var(--green-lt); color: #157a3d; border-radius: 999px; padding: 3px 9px; white-space: nowrap;
	}
	.assistant-badge.locked { background: var(--grey-line); color: var(--grey-text); }

	.assistant-body { font-size: 13px; color: var(--grey-text); line-height: 1.5; flex: 1; margin: 0; }

	.disclaimer {
		margin-top: 20px; font-size: 12px; color: var(--grey-text); line-height: 1.5;
		border-top: 1px solid var(--grey-line); padding-top: 14px;
	}
</style>
