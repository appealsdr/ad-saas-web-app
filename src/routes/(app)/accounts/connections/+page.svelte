<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	const fmt = (d: string | null) => (d ? new Date(d).toLocaleString() : 'never');
</script>

<svelte:head><title>Connected AI assistants</title></svelte:head>

<div class="page">
	<a href="/accounts">← Account</a>
	<h1>Connected AI assistants</h1>
	<p class="muted">Assistants you have allowed to act on this account. Disconnecting takes effect immediately.</p>
	{#if form?.success}<div class="alert alert-info">{form.success}</div>{/if}
	{#if form && 'error' in form && form.error}<div class="alert alert-error">{form.error}</div>{/if}

	{#each data.grants as g (g.id)}
		<div class="conn" class:off={g.revoked}>
			<div>
				<strong>{g.clientName}</strong> <span class="muted">connected by {g.userEmail}</span>
				<ul>{#each g.scopes as s}<li>{s}</li>{/each}</ul>
				<div class="muted">Connected {fmt(g.createdAt)} · last used {fmt(g.lastUsedAt)}</div>
			</div>
			{#if g.revoked}<span class="muted">Disconnected</span>
			{:else}
				<form method="POST" action="?/revoke" use:enhance><input type="hidden" name="id" value={g.id} /><button class="btn btn-outline btn-sm danger" type="submit">Disconnect</button></form>
			{/if}
		</div>
	{:else}
		<p class="muted">No assistants connected.</p>
	{/each}
</div>

<style>
	.page { padding: 24px; max-width: 760px; overflow: auto; }
	.conn { display: flex; justify-content: space-between; gap: 16px; border: 1px solid var(--grey-line, #e5e7eb); border-radius: 10px; padding: 14px; margin: 12px 0; }
	.conn.off { opacity: .55; } ul { margin: 6px 0; padding-left: 18px; } .muted { color: #6b7280; font-size: 13px; }
</style>
