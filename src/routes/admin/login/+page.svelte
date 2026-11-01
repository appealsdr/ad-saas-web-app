<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	let loading = false;
</script>

<svelte:head><title>Admin sign in — Appeals Doctor</title></svelte:head>

<div class="adm-shell">
	<main class="adm-login" aria-labelledby="t">
		<h1 id="t" class="adm-h1">Platform administration</h1>
		<p class="adm-sub">Authorized staff only. Sign-in requires multi-factor authentication.</p>

		{#if data.expired}<div class="adm-alert warn" role="status">Your session expired. Please sign in again.</div>{/if}
		{#if data.signedOut}<div class="adm-alert ok" role="status">You have been signed out.</div>{/if}
		{#if form?.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}

		<form method="POST" use:enhance={() => { loading = true; return async ({ update }) => { loading = false; await update(); }; }}>
			<input type="hidden" name="next" value={data.next} />
			<label for="email">Email address</label>
			<input id="email" name="email" type="email" autocomplete="username" required value={form?.email ?? ''} />
			<label for="password">Password</label>
			<input id="password" name="password" type="password" autocomplete="current-password" required />
			<p style="margin-top:20px"><button class="adm-btn" type="submit" disabled={loading}>{loading ? 'Signing in…' : 'Continue'}</button></p>
		</form>
	</main>
</div>
