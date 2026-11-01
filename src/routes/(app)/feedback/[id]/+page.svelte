<script lang="ts">
	import { enhance } from '$app/forms';
	import Topbar from '$components/layout/Topbar.svelte';
	import RichTextEditor from '$components/ui/RichTextEditor.svelte';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	let editing = false;
	let editBody = data.feedback.body ?? '';
	let saving = false;

	function fmtDateTime(iso: string | null | undefined) {
		if (!iso) return '—';
		try {
			const d = new Date(iso);
			return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
				+ ' at ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
		} catch { return iso; }
	}

	function startEdit() {
		editBody = data.feedback.body ?? '';
		editing = true;
	}
</script>

<svelte:head><title>Feedback — Appeals Doctor</title></svelte:head>

<Topbar title="Feedback detail" subtitle={data.feedback.status ?? undefined}>
	<a class="btn btn-outline btn-sm" href="/feedback">← Back to feedback</a>
</Topbar>

<div class="content-area">
	{#if form?.updateSuccess}<div class="alert alert-success" style="margin-bottom:14px">{form.updateSuccess}</div>{/if}
	{#if form?.updateError}<div class="alert alert-error" style="margin-bottom:14px">{form.updateError}</div>{/if}

	<div class="card" style="padding:20px">
		<div class="fields-2col" style="margin-bottom:16px">
			<div class="field-block">
				<div class="field-label">Status</div>
				<div class="field-value"><span class="badge badge-grey">{data.feedback.status ?? '—'}</span></div>
			</div>
			<div class="field-block">
				<div class="field-label">Submitted</div>
				<div class="field-value">{fmtDateTime(data.feedback.createdAt)}</div>
			</div>
		</div>

		{#if editing}
			<form
				method="POST"
				action="?/update"
				use:enhance={() => {
					saving = true;
					return async ({ update }) => {
						await update();
						saving = false;
						editing = false;
					};
				}}
			>
				<RichTextEditor bind:value={editBody} />
				<input type="hidden" name="body" value={editBody} />
				<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">
					<button type="button" class="btn btn-outline btn-sm" on:click={() => (editing = false)}>
						Cancel
					</button>
					<button type="submit" class="btn btn-primary btn-sm" disabled={saving || !editBody.trim()}>
						{saving ? 'Saving…' : 'Save changes'}
					</button>
				</div>
			</form>
		{:else}
			<div class="feedback-body">{@html data.feedback.body ?? ''}</div>
			<div style="margin-top:14px">
				<button class="btn btn-outline btn-sm" on:click={startEdit}>Edit feedback</button>
			</div>
		{/if}
	</div>
</div>

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }
	.fields-2col { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 14px; }
	.field-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--grey-text); margin-bottom: 4px; }
	.field-value { font-size: 14px; }
	.feedback-body { font-size: 14px; line-height: 1.6; }
	.feedback-body :global(ul), .feedback-body :global(ol) {
		margin: 4px 0; padding-left: 22px;
	}
</style>
