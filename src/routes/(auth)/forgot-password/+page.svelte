<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	export let form: ActionData;

	let loading = false;
</script>

<svelte:head>
	<title>Forgot Password — Appeals Doctor</title>
</svelte:head>

<div class="auth-card">
	<div class="auth-logo">
		<img src="/icons/company_logo.svg" alt="Appeals Doctor" width="200" />
	</div>

	{#if form?.success}
		<div class="success-state">
			<div class="success-icon">✉️</div>
			<div class="auth-title">Check your email</div>
			<div class="auth-sub">
				If an account exists for that address, we've sent a link to reset your password. The link
				expires in 1 hour.
			</div>
			<a href="/login" class="btn btn-primary btn-full" style="margin-top:24px">Back to sign in</a>
		</div>
	{:else}
		<div class="auth-title">Forgot your password?</div>
		<div class="auth-sub">
			Enter your email address and we'll send you a link to reset your password.
		</div>

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
			<div class="form-group">
				<label for="email">Email address</label>
				<input
					id="email"
					name="email"
					type="email"
					class="form-control"
					placeholder="you@company.com"
					required
					value={form?.email ?? ''}
				/>
			</div>

			<button type="submit" class="btn btn-primary btn-full btn-lg" disabled={loading}>
				{loading ? 'Sending…' : 'Send reset link'}
			</button>
		</form>

		<p class="hint">
			<a href="/login" class="link-btn">Back to sign in</a>
		</p>
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

	.success-state {
		text-align: center;
	}

	.success-icon {
		font-size: 48px;
		margin-bottom: 16px;
	}

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
</style>
