<script lang="ts">
	import { enhance } from '$app/forms';
	import PasswordInput from '$components/ui/PasswordInput.svelte';
	import type { ActionData, PageData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	let loading = false;

	// token from URL (passed through the form as a hidden field)
	$: token = form?.token ?? data.token ?? '';
</script>

<svelte:head>
	<title>Reset Password — Appeals Doctor</title>
</svelte:head>

<div class="auth-card">
	<div class="auth-logo">
		<img src="/icons/company_logo.svg" alt="Appeals Doctor" width="200" />
	</div>

	{#if !data.valid}
		<div class="auth-title">Link expired</div>
		<div class="auth-sub">{data.error ?? 'This reset link is invalid or has already been used.'}</div>
		<a href="/forgot-password" class="btn btn-primary btn-full" style="margin-top:24px">
			Request a new link
		</a>
	{:else}
		<div class="auth-title">Choose a new password</div>
		<div class="auth-sub">Enter a new password for your account.</div>

		{#if form?.error}
			<div class="alert alert-error" style="margin-bottom:16px">{form.error}</div>
		{/if}

		<form
			method="POST"
			use:enhance={() => {
				loading = true;
				return ({ update }) => {
					loading = false;
					update();
				};
			}}
		>
			<input type="hidden" name="token" value={token} />

			<div class="form-group">
				<label for="password">New password</label>
				<PasswordInput id="password" name="password" placeholder="At least 8 characters" minlength={8} required autocomplete="new-password" />
			</div>

			<div class="form-group">
				<label for="confirm">Confirm new password</label>
				<PasswordInput id="confirm" name="confirm" minlength={8} required autocomplete="new-password" />
			</div>

			<button type="submit" class="btn btn-primary btn-full btn-lg" disabled={loading}>
				{loading ? 'Saving…' : 'Set new password'}
			</button>
		</form>

		{#if data.forced}
			<div class="auth-divider">or</div>

			<a
				href={`/auth/google?reset_token=${encodeURIComponent(token)}`}
				class="btn btn-outline btn-full"
				style="gap:10px;justify-content:center"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
					<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
					<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
					<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
					<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
				</svg>
				Continue with Google instead
			</a>
		{/if}
	{/if}
</div>

<style>
	.auth-card {
		background: white;
		border-radius: 20px;
		padding: 40px;
		width: 100%;
		max-width: 420px;
		box-shadow: var(--shadow-xl);
	}

	.auth-logo {
		text-align: center;
		margin-bottom: 28px;
	}

	.auth-title {
		font-size: 22px;
		font-weight: 800;
		margin-bottom: 4px;
		color: var(--navy);
	}

	.auth-sub {
		font-size: 14px;
		color: var(--grey-text);
		margin-bottom: 26px;
	}
</style>
