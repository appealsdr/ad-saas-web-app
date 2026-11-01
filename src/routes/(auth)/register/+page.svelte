<script lang="ts">
	import { enhance } from '$app/forms';
	import PasswordInput from '$components/ui/PasswordInput.svelte';
	import type { ActionData, PageData } from './$types';

	export let form: ActionData;
	export let data: PageData;

	$: nextPath = data.next ?? '';
	let loading = false;
</script>

<svelte:head>
	<title>Create account — Appeals Doctor</title>
</svelte:head>

<div class="auth-card">
	<div class="auth-logo">
		<img src="/icons/company_logo.svg" alt="Appeals Doctor" width="200" />
	</div>

	<div class="auth-title">Create your account</div>
	<div class="auth-sub">Start managing your Amazon appeals</div>

	{#if form?.error}
		<div class="alert alert-error">
			{form.error}
			{#if form?.emailTaken}
				<a
					href={`/login?email=${encodeURIComponent(form?.email ?? '')}${nextPath ? `&next=${encodeURIComponent(nextPath)}` : ''}`}
					class="link-btn"
					style="margin-left:6px"
				>Sign in instead →</a>
			{/if}
		</div>
	{/if}

	<form
		method="POST"
		action="?/register"
		use:enhance={() => {
			loading = true;
			return ({ update }) => { loading = false; update(); };
		}}
	>
		{#if nextPath}
			<input type="hidden" name="next" value={nextPath} />
		{/if}
		<div class="form-group">
			<label for="name">Full name</label>
			<input id="name" name="name" type="text" class="form-control"
				placeholder="Jane Doe" required value={form?.name ?? ''} />
		</div>

		<div class="form-group">
			<label for="company">Company name</label>
			<input id="company" name="company" type="text" class="form-control"
				placeholder="Acme Inc." required value={form?.company ?? ''} />
		</div>

		<div class="form-group">
			<label for="email">Email address</label>
			<input id="email" name="email" type="email" class="form-control"
				class:input-error={form?.emailTaken}
				placeholder="you@company.com" required value={form?.email ?? ''}
				aria-invalid={form?.emailTaken ? 'true' : undefined} />
		</div>

		<div class="form-group">
			<label for="phone">Phone number</label>
			<input id="phone" name="phone" type="tel" class="form-control"
				placeholder="+1 415 555 0100" required value={form?.phone ?? ''} />
		</div>

		<div class="form-group">
			<label for="website">Website</label>
			<input id="website" name="website" type="url" class="form-control"
				placeholder="https://acme.com" required value={form?.website ?? ''} />
		</div>

		<div class="form-group">
			<label for="password">Password</label>
			<PasswordInput id="password" name="password" placeholder="At least 8 characters" required minlength={8} autocomplete="new-password" />
		</div>

		<div class="form-group">
			<label for="confirm">Confirm password</label>
			<PasswordInput id="confirm" name="confirm" placeholder="Repeat password" required autocomplete="new-password" />
		</div>

		<button type="submit" class="btn btn-primary btn-full btn-lg" disabled={loading}>
			{loading ? 'Creating account…' : 'Create account'}
		</button>
	</form>

	<div class="auth-divider">or</div>

	<a href="/auth/google" class="btn btn-outline btn-full" style="gap:10px;justify-content:center">
		<svg width="18" height="18" viewBox="0 0 24 24" fill="none">
			<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
			<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
			<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
			<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
		</svg>
		Continue with Google
	</a>

	<p class="hint">
		Already have an account?
		<a href={nextPath ? `/login?next=${encodeURIComponent(nextPath)}` : '/login'} class="link-btn">Sign in</a>
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
	.auth-logo { text-align: center; margin-bottom: 22px; }
	.auth-title { font-size: 22px; font-weight: 800; margin-bottom: 4px; color: var(--navy); }
	.auth-sub { font-size: 14px; color: var(--grey-text); margin-bottom: 22px; }
	.auth-divider {
		text-align: center; color: var(--grey-text); font-size: 13px;
		margin: 16px 0; position: relative;
	}
	.auth-divider::before,.auth-divider::after {
		content:''; position:absolute; top:50%; width:42%; height:1px; background:var(--grey-line);
	}
	.auth-divider::before{left:0} .auth-divider::after{right:0}
	.hint { font-size:13px; color:var(--grey-text); text-align:center; margin-top:16px; }
	.link-btn { background:none; border:none; color:var(--orange); font-weight:600; font-size:inherit; text-decoration:underline; cursor:pointer; }
	.input-error { border-color: var(--red, #dc2626); }
</style>
