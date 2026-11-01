<script lang="ts">
	import { applyAction, enhance } from '$app/forms';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	let loading = false;
	let useRecovery = false;
</script>

<svelte:head><title>Verify your identity — Admin</title></svelte:head>

<div class="adm-shell">
	<main class="adm-login" aria-labelledby="t">
		{#if form && 'recoveryCodes' in form && form.recoveryCodes}
			<h1 id="t" class="adm-h1">Save your recovery codes</h1>
			<p class="adm-sub">Each code works once if you lose your authenticator. They are shown <strong>only now</strong> and are not stored.</p>
			<pre class="adm-pre" aria-label="Recovery codes">{form.recoveryCodes.join('\n')}</pre>
			<p style="margin-top:16px"><a class="adm-btn" href={form.next} data-sveltekit-reload>I saved them — continue</a></p>
		{:else if data.stage === 'done'}
			<h1 id="t" class="adm-h1">Signed in</h1>
			<p><a class="adm-btn" href="/admin/accounts" data-sveltekit-reload>Continue to accounts</a></p>
		{:else}
			<h1 id="t" class="adm-h1">{data.stage === 'mfa_enroll' ? 'Set up multi-factor authentication' : 'Enter your verification code'}</h1>
			<p class="adm-sub">Signed in as {data.email}</p>
			{#if data.configError}<div class="adm-alert error" role="alert">{data.configError}</div>{/if}
			{#if form && 'error' in form && form.error}<div class="adm-alert error" role="alert">{form.error}</div>{/if}

			{#if data.stage === 'mfa_enroll' && data.qrSvg}
				<p class="adm-sub">Scan this QR code with an authenticator app, or enter the key manually, then type the 6-digit code.</p>
				<div aria-label="QR code for authenticator app">{@html data.qrSvg}</div>
				<p class="adm-mono">Key: {data.secret}</p>
			{/if}

			<form
				method="POST"
				use:enhance={() => {
					loading = true;
					return async ({ result, update }) => {
						loading = false;
						// On success (enrollment) show the one-time recovery codes WITHOUT re-running
						// loads: the session now exists, so a reload would redirect past this screen.
						if (result.type === 'success') await applyAction(result);
						else await update();
					};
				}}
			>
				{#if useRecovery && data.stage === 'mfa_challenge'}
					<label for="recovery">Recovery code</label>
					<input id="recovery" name="recovery" type="text" autocomplete="off" required />
				{:else}
					<label for="code">6-digit code</label>
					<input id="code" name="code" type="text" inputmode="numeric" pattern="[0-9 ]*" autocomplete="one-time-code" required />
				{/if}
				<p style="margin-top:20px"><button class="adm-btn" type="submit" disabled={loading || !!data.configError}>{loading ? 'Verifying…' : 'Verify'}</button></p>
			</form>
			{#if data.stage === 'mfa_challenge'}
				<p><button class="adm-btn outline sm" type="button" on:click={() => (useRecovery = !useRecovery)}>{useRecovery ? 'Use authenticator code' : 'Use a recovery code'}</button></p>
			{/if}
		{/if}
	</main>
</div>
