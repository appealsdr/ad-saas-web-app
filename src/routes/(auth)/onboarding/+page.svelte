<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';

	export let data: PageData;
	export let form: ActionData;

	let loading = false;
</script>

<svelte:head>
	<title>Finish setup — Appeals Doctor</title>
</svelte:head>

<div class="auth-card">
	<div class="auth-logo">
		<span style="font-size:36px">⚕</span>
		<div style="font-size:20px;font-weight:800;color:var(--navy);margin-top:6px">Appeals Doctor</div>
	</div>

	<div class="auth-title">Finish setting up your account</div>
	<div class="auth-sub">A couple of details so we can set up your account and start your cases.</div>

	{#if form?.error}
		<div class="alert alert-error">{form.error}</div>
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
			<label for="name">Full name</label>
			<input id="name" name="name" type="text" class="form-control"
				placeholder="Jane Doe" value={form?.name ?? data.name ?? ''} />
		</div>

		<div class="form-group">
			<label for="email">Email</label>
			<input id="email" type="email" class="form-control" value={data.email} disabled />
		</div>

		<div class="form-group">
			<label for="company">Company name <span class="req">*</span></label>
			<input id="company" name="company" type="text" class="form-control"
				placeholder="Acme Inc." required value={form?.company ?? ''} />
		</div>

		<div class="form-group">
			<label for="website">Website</label>
			<input id="website" name="website" type="text" class="form-control"
				placeholder="acme.com" value={form?.website ?? ''} />
		</div>

		<div class="form-group">
			<label for="phone">Phone</label>
			<input id="phone" name="phone" type="tel" class="form-control"
				placeholder="+1 415 555 0100" value={form?.phone ?? ''} />
		</div>

		<button type="submit" class="btn btn-primary btn-full btn-lg" disabled={loading}>
			{loading ? 'Saving…' : 'Continue'}
		</button>
	</form>
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
	.req { color: var(--orange); }
</style>
