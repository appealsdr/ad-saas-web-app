<script lang="ts">
	import { goto } from '$app/navigation';
	import { enhance } from '$app/forms';
	import Topbar from '$components/layout/Topbar.svelte';
	import RichTextEditor from '$components/ui/RichTextEditor.svelte';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	let query = '';
	$: filtered = (data.feedback ?? []).filter((f) => {
		if (!query.trim()) return true;
		const q = query.toLowerCase();
		const plain = (f.body ?? '').replace(/<[^>]*>/g, ' ').toLowerCase();
		return plain.includes(q) || (f.status ?? '').toLowerCase().includes(q);
	});

	function fmtDate(iso: string | null | undefined) {
		if (!iso) return '—';
		try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
	}
	function truncate(html: string | null, max = 140): string {
		const plain = (html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
		return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain || '(empty)';
	}

	let showNewForm = false;
	let newBody = '';
	let submitting = false;
</script>

<svelte:head><title>Feedback — Appeals Doctor</title></svelte:head>

<Topbar title="Feedback" subtitle="Share feedback about a feature or your experience">
	<button class="btn btn-primary btn-sm" on:click={() => (showNewForm = !showNewForm)}>
		{showNewForm ? 'Cancel' : '+ New feedback'}
	</button>
</Topbar>

<div class="content-area">
	{#if form?.createError}
		<div class="alert alert-error" style="margin-bottom:16px">{form.createError}</div>
	{/if}

	{#if showNewForm}
		<div class="card" style="padding:16px;margin-bottom:16px">
			<form
				method="POST"
				action="?/create"
				use:enhance={() => {
					submitting = true;
					return async ({ update }) => {
						await update();
						submitting = false;
					};
				}}
			>
				<RichTextEditor bind:value={newBody} placeholder="What would you like to tell us?" />
				<input type="hidden" name="body" value={newBody} />
				<div style="margin-top:10px;display:flex;justify-content:flex-end">
					<button class="btn btn-primary btn-sm" type="submit" disabled={submitting || !newBody.trim()}>
						{submitting ? 'Submitting…' : 'Submit feedback'}
					</button>
				</div>
			</form>
		</div>
	{/if}

	<div class="bar">
		<div class="search-wrap">
			<input
				type="search"
				class="form-control"
				placeholder="Search feedback…"
				bind:value={query}
			/>
		</div>
		<div class="count">{filtered.length} of {data.feedback.length}</div>
	</div>

	{#if data.feedbackError}
		<div class="alert alert-error" style="margin-bottom:16px">
			Could not load feedback from Salesforce: {data.feedbackError}
		</div>
	{/if}

	{#if filtered.length === 0}
		<div class="card" style="padding:24px;text-align:center;color:var(--grey-text)">
			{#if query.trim()}No feedback matches "{query}".{:else}No feedback shared yet.{/if}
		</div>
	{:else}
		<div class="card" style="padding:0">
			<table class="data-table">
				<thead>
					<tr>
						<th>Feedback</th>
						<th>Status</th>
						<th>Submitted</th>
					</tr>
				</thead>
				<tbody>
					{#each filtered as f (f.Id)}
						<tr class="clickable" on:click={() => goto(`/feedback/${f.Id}`)}>
							<td class="subject">{truncate(f.body)}</td>
							<td><span class="badge badge-grey">{f.status ?? '—'}</span></td>
							<td>{fmtDate(f.createdAt)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }

	.bar { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
	.search-wrap { flex: 1; min-width: 220px; max-width: 360px; }
	.count { font-size: 13px; color: var(--grey-text); margin-left: auto; }

	.data-table { width: 100%; border-collapse: collapse; }
	.data-table th {
		text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
		color: var(--grey-text); padding: 10px 14px; border-bottom: 1px solid var(--grey-line);
	}
	.data-table td { padding: 12px 14px; font-size: 13px; border-bottom: 1px solid var(--grey-line); }
	.data-table tr:last-child td { border-bottom: none; }
	.data-table tr.clickable { cursor: pointer; }
	.data-table tr.clickable:hover { background: var(--grey-bg); }
	.subject { max-width: 480px; }
</style>
