<script lang="ts">
	import type { PageData } from './$types';
	export let data: PageData;
</script>

<svelte:head><title>Check your email — Appeals Doctor</title></svelte:head>

<div class="auth-card">
	<div class="auth-logo"><img src="/icons/company_logo.svg" alt="Appeals Doctor" width="200" /></div>
	<div class="icon">✉️</div>
	<div class="auth-title">Confirm your email</div>
	<div class="auth-sub">
		{#if data.email}We've sent a confirmation link to <strong>{data.email}</strong>.{:else}We've sent you a confirmation link.{/if}
		Click it within 24 hours to finish creating your account. Check your spam folder if you don't see it.
	</div>
	<a href="/login" class="btn btn-outline btn-full">Back to sign in</a>
</div>

<style>
	.auth-card { background: white; border-radius: 20px; padding: 40px; width: 100%; max-width: 420px; box-shadow: var(--shadow-xl); text-align: center; }
	.auth-logo { margin-bottom: 18px; }
	.icon { font-size: 40px; margin-bottom: 8px; }
	.auth-title { font-size: 22px; font-weight: 800; margin-bottom: 8px; color: var(--navy); }
	.auth-sub { font-size: 14px; color: var(--grey-text); margin-bottom: 24px; line-height: 1.5; }
</style>
