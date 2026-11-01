<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
</script>

<svelte:head><title>Re-verify — Admin</title></svelte:head>
<div class="adm-card" style="max-width:420px">
	<h1 class="adm-h1">Confirm it’s you</h1>
	<p class="adm-sub">This action needs a recent multi-factor check (within 5 minutes).</p>
	{#if form?.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}
	<form method="POST" use:enhance>
		<input type="hidden" name="next" value={data.next} />
		<label class="adm-muted" for="code">6-digit code</label>
		<input id="code" name="code" class="adm-input" inputmode="numeric" autocomplete="one-time-code" required style="width:100%" />
		<p><button class="adm-btn" type="submit">Verify</button></p>
	</form>
</div>
