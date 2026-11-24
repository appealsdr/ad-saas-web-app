<script lang="ts">
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	let busy = false;
	$: done = form && 'done' in form && form.done ? form : null;
</script>

<svelte:head><title>Upload a document</title><meta name="robots" content="noindex" /></svelte:head>

<main class="wrap">
	<div class="card">
		{#if done}
			<h1>Uploaded ✓</h1>
			<p><strong>{done.fileName}</strong> was received{done.synced ? '' : ' and is being processed'}. You can close this page and go back to the assistant.</p>
		{:else if data.state === 'ready'}
			<h1>Upload: {data.slotName}</h1>
			{#if data.description}<p>{data.description}</p>{/if}
			{#if data.instructions}<p class="muted">{data.instructions}</p>{/if}
			{#if form && 'error' in form && form.error}<p class="err" role="alert">{form.error}</p>{/if}
			<form method="POST" action="?/upload" enctype="multipart/form-data" on:submit={() => (busy = true)}>
				<input type="file" name="file" required accept={data.acceptedFormats.map((f) => `.${f}`).join(',')} />
				<p class="muted">
					{data.acceptedFormats.length ? `Accepted: ${data.acceptedFormats.join(', ')}. ` : ''}Up to {data.maxMb} MB. This link works once and expires at
					{new Date(data.expiresAt).toLocaleTimeString()}.
				</p>
				<button class="btn primary" type="submit" disabled={busy}>{busy ? 'Uploading…' : 'Upload'}</button>
			</form>
		{:else if data.state === 'disabled'}
			<h1>Uploads are unavailable</h1>
			<p>This feature is temporarily turned off. Please contact support.</p>
		{:else}
			<h1>This link can't be used</h1>
			<p>It has expired or was already used. Ask the assistant for a new upload link.</p>
		{/if}
	</div>
</main>

<style>
	.wrap { min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; padding: 24px; }
	.card { background: #fff; max-width: 460px; width: 100%; border-radius: 14px; padding: 28px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
	h1 { font-size: 20px; margin: 0 0 12px; } .muted { color: #6b7280; font-size: 13px; } .err { color: #b91c1c; }
	input[type='file'] { display: block; margin: 16px 0 8px; max-width: 100%; }
	.btn { padding: 9px 16px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; }
	.btn.primary { background: #0f766e; color: #fff; border-color: #0f766e; } .btn:disabled { opacity: .6; cursor: default; }
</style>
