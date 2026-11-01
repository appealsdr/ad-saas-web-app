<script lang="ts">
	import { enhance } from '$app/forms';
	import PasswordInput from '$components/ui/PasswordInput.svelte';
	import type { ActionData, PageData } from './$types';

	export let form: ActionData;
	export let data: PageData;

	// `next` came in via ?next=… on /login (set by the auth guard / SF email).
	// Server-validated already; we just echo it back as a hidden form field
	// so the action knows where to send the user after a successful sign-in.
	$: nextPath = data.next ?? '';

	let loading = false;
</script>

<svelte:head>
	<title>Login — Appeals Doctor</title>
</svelte:head>

<div class="auth-card">
	<!-- Logo -->
	<div class="auth-logo">
		<img src="/icons/company_logo.svg" alt="Appeals Doctor" width="200" />
	</div>

	<div class="auth-title">Welcome back</div>
	<div class="auth-sub">Sign in to your account to continue</div>

	<!-- Success banner after password reset -->
	{#if data.passwordReset}
		<div class="alert alert-success" style="margin-bottom:16px">
			Your password has been updated. Sign in with your new password.
		</div>
	{/if}

	<!-- Error banner -->
	{#if form?.error}
		<div class="alert alert-error" style="margin-bottom:16px">{form.error}</div>
	{/if}

	<!-- Email / password form -->
	<form
		method="POST"
		action="?/login"
		aria-busy={loading}
		use:enhance={() => {
			loading = true;
			return ({ update }) => {
				loading = false;
				update();
			};
		}}
	>
		{#if nextPath}
			<input type="hidden" name="next" value={nextPath} />
		{/if}
		<div class="form-group">
			<label for="email">Email address</label>
			<input
				id="email"
				name="email"
				type="email"
				class="form-control"
				placeholder="you@company.com"
				required
				disabled={loading}
				value={form?.email ?? data.email ?? ''}
			/>
		</div>

		<div class="form-group">
			<label for="password">Password</label>
			<PasswordInput id="password" name="password" required disabled={loading} autocomplete="current-password" />
		</div>

		<div style="text-align:right;margin-bottom:16px">
			<a href="/forgot-password" class="link-btn" style="font-size:13px">Forgot password?</a>
		</div>

		<button type="submit" class="btn btn-primary btn-full btn-lg" disabled={loading}>
			{#if loading}
				<span class="spinner" aria-hidden="true"></span>
				Signing in…
			{:else}
				Sign in
			{/if}
		</button>
	</form>

	<div class="auth-divider">or</div>

	<!-- Google OAuth -->
	<a href={nextPath ? `/auth/google?next=${encodeURIComponent(nextPath)}` : '/auth/google'}
		class="btn btn-outline btn-full" style="gap:10px;justify-content:center">
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
			<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
			<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
			<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
			<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
		</svg>
		Continue with Google
	</a>

	<p class="hint">
		Don't have an account?
		<a href={nextPath ? `/register?next=${encodeURIComponent(nextPath)}` : '/register'} class="link-btn">Sign up</a>
	</p>
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

	.auth-divider {
		text-align: center;
		color: var(--grey-text);
		font-size: 13px;
		margin: 18px 0;
		position: relative;
	}
	.auth-divider::before,
	.auth-divider::after {
		content: '';
		position: absolute;
		top: 50%;
		width: 42%;
		height: 1px;
		background: var(--grey-line);
	}
	.auth-divider::before { left: 0; }
	.auth-divider::after  { right: 0; }

	.hint {
		font-size: 13px;
		color: var(--grey-text);
		text-align: center;
		margin-top: 18px;
	}

	.link-btn {
		background: none;
		border: none;
		color: var(--orange);
		font-weight: 600;
		font-size: inherit;
		text-decoration: underline;
		cursor: pointer;
	}

	.spinner {
		width: 16px;
		height: 16px;
		border: 2px solid rgba(255, 255, 255, 0.35);
		border-top-color: white;
		border-radius: 50%;
		animation: spin 0.65s linear infinite;
		flex-shrink: 0;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
