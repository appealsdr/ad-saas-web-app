<script lang="ts">
	import { enhance } from '$app/forms';
	import { browserTimeZone, formatDateTime, resolveTimeZone } from '$lib/admin/time';
	import { invalidateAll } from '$app/navigation';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;

	let value = data.current ?? '';
	let q = '';
	$: zones = data.zones.filter((z) => !q.trim() || z.toLowerCase().includes(q.trim().toLowerCase().replace(/\s+/g, '_')));
	$: preview = formatDateTime(new Date(), resolveTimeZone(value || null), { seconds: true });
	const browser = browserTimeZone();
</script>

<svelte:head><title>Time zone — Admin</title></svelte:head>
<h1 class="adm-h1">Display time zone</h1>
<p class="adm-sub">Every timestamp in the admin panel is shown in this time zone. Stored data stays in UTC — changing this only changes what you see.</p>
{#if form && 'ok' in form && form.ok}<div class="adm-alert ok" role="status">{form.ok}</div>{/if}
{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}

<div class="adm-card" style="max-width:520px">
	<form method="POST" use:enhance={() => async ({ update }) => { await update({ reset: false }); await invalidateAll(); }}>
		<label>Search<input class="adm-input" type="search" bind:value={q} placeholder="e.g. new_york, london, tokyo" /></label>
		<label style="display:block;margin-top:10px">Time zone
			<select class="adm-input" name="timeZone" bind:value size="8" style="width:100%">
				<option value="">Automatic — {browser ?? 'UTC'} (this browser)</option>
				{#each zones as z}<option value={z}>{z}</option>{/each}
			</select>
		</label>
		<p class="adm-muted">Now: <strong>{preview}</strong></p>
		<button class="adm-btn" type="submit">Save</button>
	</form>
</div>
