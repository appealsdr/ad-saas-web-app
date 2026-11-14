<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	let loading = false;
</script>

<svelte:head><title>Confirm email — Appeals Doctor</title></svelte:head>

<div class="auth-card">
	<div class="auth-logo"><img src="/icons/company_logo.svg" alt="Appeals Doctor" width="200" /></div>
	{#if form?.sent}
		<div class="auth-title">Check your email</div>
		<div class="auth-sub">If that address has an unconfirmed signup, we've sent a new link. It expires in 24 hours.</div>
		<a href="/login" class="btn btn-primary btn-full">Back to sign in</a>
	{:else}
		<div class="auth-title">This link can't be used</div>
		<div class="auth-sub">
			{data.problem === 'expired' ? 'This confirmation link has expired.' : 'This confirmation link is invalid.'}
			Enter your email and we'll send you a new one.
		</div>
		{#if form?.error}<div class="alert alert-error">{form.error}</div>{/if}
		<form method="POST" action="?/resend" use:enhance={() => { loading = true; return ({ update }) => { loading = false; update(); }; }}>
			<div class="form-group">
				<label for="email">Email address</label>
				<input id="email" name="email" type="email" class="form-control" placeholder="you@company.com" required />
			</div>
			<button type="submit" class="btn btn-primary btn-full" disabled={loading}>{loading ? 'Sending…' : 'Send a new link'}</button>
		</form>
	{/if}
</div>

<style>
	.auth-card { background: white; border-radius: 20px; padding: 40px; width: 100%; max-width: 420px; box-shadow: var(--shadow-xl); }
	.auth-logo { text-align: center; margin-bottom: 18px; }
	.auth-title { font-size: 22px; font-weight: 800; margin-bottom: 8px; color: var(--navy); }
	.auth-sub { font-size: 14px; color: var(--grey-text); margin-bottom: 20px; line-height: 1.5; }
</style>
