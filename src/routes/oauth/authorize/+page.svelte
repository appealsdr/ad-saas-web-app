<script lang="ts">
	import { page } from '$app/stores';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	const keep = ['client_id', 'redirect_uri', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'state', 'resource'];
</script>

<svelte:head><title>Connect an AI assistant</title></svelte:head>

<main class="wrap">
	<div class="card">
		{#if data.error}
			<h1>Can't connect</h1>
			<p class="err" role="alert">{data.error}</p>
			<a class="btn" href="/dashboard">Back to the app</a>
		{:else}
			<h1>Connect <em>{data.clientName}</em></h1>
			<p><strong>{data.clientName}</strong> wants to access the <strong>{data.accountName}</strong> account as <strong>{data.email}</strong>.</p>
			{#if form?.error}<p class="err" role="alert">{form.error}</p>{/if}
			<form method="POST">
				{#each keep as k}{#if $page.url.searchParams.get(k) !== null}<input type="hidden" name={k} value={$page.url.searchParams.get(k)} />{/if}{/each}
				<fieldset>
					<legend>Allow it to:</legend>
					{#each data.scopes as s}
						<label><input type="checkbox" name="scope" value={s.id} checked={s.checked} disabled={s.required} /> {s.label}</label>
						{#if s.required}<input type="hidden" name="scope" value={s.id} />{/if}
					{/each}
				</fieldset>
				<p class="muted">Anything it uploads or posts is sent in your name and visible to our team. You can disconnect it at any time in Account → Connected assistants.</p>
				<div class="row">
					<button class="btn" name="decision" value="deny" type="submit">Cancel</button>
					<button class="btn primary" name="decision" value="approve" type="submit">Allow</button>
				</div>
			</form>
		{/if}
	</div>
</main>

<style>
	.wrap { min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; padding: 24px; }
	.card { background: #fff; max-width: 460px; width: 100%; border-radius: 14px; padding: 28px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
	h1 { font-size: 20px; margin: 0 0 12px; } fieldset { border: 1px solid #e5e7eb; border-radius: 10px; margin: 16px 0; padding: 10px 14px; }
	label { display: block; margin: 8px 0; } .muted { color: #6b7280; font-size: 13px; } .err { color: #b91c1c; }
	.row { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
	.btn { padding: 9px 16px; border-radius: 8px; border: 1px solid #d1d5db; background: #fff; cursor: pointer; text-decoration: none; color: inherit; }
	.btn.primary { background: #0f766e; color: #fff; border-color: #0f766e; }
</style>
