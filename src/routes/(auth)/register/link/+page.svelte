<script lang="ts">
	import { enhance } from '$app/forms';
	import { page } from '$app/stores';
	import PasswordInput from '$components/ui/PasswordInput.svelte';
	import type { ActionData, PageData } from './$types';

	export let form: ActionData;
	export let data: PageData;

	let loading = false;
	$: token = $page.url.searchParams.get('t') ?? '';
	$: v = data.values;
</script>

<svelte:head><title>Finish sign-up — Appeals Doctor</title></svelte:head>

<div class="auth-card">
	<div class="auth-logo"><img src="/icons/company_logo.svg" alt="Appeals Doctor" width="200" /></div>

	{#if data.error}
		<div class="auth-title">Sign-up link</div>
		<div class="alert alert-error">{data.error}</div>
		<a href="/login" class="btn btn-primary btn-full">{data.signedUp ? 'Sign in' : 'Go to sign in'}</a>
	{:else if v}
		<div class="auth-title">Finish setting up your account</div>
		<div class="auth-sub">
			We found your details. Review or edit them and choose a password.
			{#if data.stores?.length}<br />Linked stores: <strong>{data.stores.join(', ')}</strong>{/if}
			{#if data.hasContract}<br />Your service contract will be linked to this account.{/if}
		</div>

		{#if form?.error}<div class="alert alert-error">{form.error}</div>{/if}

		<form method="POST" use:enhance={() => { loading = true; return ({ update }) => { loading = false; update(); }; }}>
			<input type="hidden" name="t" value={token} />
			<div class="form-group"><label for="name">Full name</label>
				<input id="name" name="name" class="form-control" required value={form?.name ?? v.name} /></div>
			<div class="form-group"><label for="company">Company name</label>
				<input id="company" name="company" class="form-control" required value={form?.company ?? v.company} /></div>
			<div class="form-group"><label for="email">Email address</label>
				<input id="email" name="email" type="email" class="form-control" required value={form?.email ?? v.email} /></div>
			<div class="form-group"><label for="phone">Phone number</label>
				<input id="phone" name="phone" type="tel" class="form-control" required value={form?.phone ?? v.phone} /></div>
			<div class="form-group"><label for="website">Website</label>
				<input id="website" name="website" class="form-control" required value={form?.website ?? v.website} /></div>
			<div class="form-group"><label for="password">Password</label>
				<PasswordInput id="password" name="password" placeholder="At least 8 characters" required minlength={8} autocomplete="new-password" /></div>
			<div class="form-group"><label for="confirm">Confirm password</label>
				<PasswordInput id="confirm" name="confirm" placeholder="Repeat password" required autocomplete="new-password" /></div>
			<button type="submit" class="btn btn-primary btn-full btn-lg" disabled={loading}>
				{loading ? 'Creating account…' : 'Create account'}
			</button>
		</form>
	{/if}
</div>

<style>
	.auth-card { background: white; border-radius: 20px; padding: 40px; width: 100%; max-width: 420px; box-shadow: var(--shadow-xl); }
	.auth-logo { text-align: center; margin-bottom: 22px; }
	.auth-title { font-size: 22px; font-weight: 800; margin-bottom: 4px; color: var(--navy); }
	.auth-sub { font-size: 14px; color: var(--grey-text); margin-bottom: 22px; }
</style>
