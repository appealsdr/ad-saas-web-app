<script lang="ts">
	import { enhance } from '$app/forms';
	import { createEventDispatcher } from 'svelte';

	/** Confirm / edit dialog for an admin record action (mockup modal). */
	export let title: string;
	export let body: string;
	export let recordName: string;
	export let recordId: string;
	export let action: string;
	export let hidden: Record<string, string> = {};
	/** edit = fields · sync/reason = reason only · delete/confirm = reason + typed confirmation */
	export let kind: 'edit' | 'sync' | 'delete' | 'reason' | 'confirm';
	/** Plain browser submit (needed when the action redirects into another app area). */
	export let native = false;
	export let fields: { name: string; label: string; value: string; type?: string; required?: boolean; full?: boolean }[] = [];
	/** Delete: the exact text the admin must type. */
	export let confirmText = '';
	export let submitLabel = 'Submit';
	export let error: string | null = null;

	const dispatch = createEventDispatcher<{ close: void }>();
	let reason = '';
	let typed = '';
	let busy = false;
	$: needsTyped = kind === 'delete' || kind === 'confirm';
	$: dangerous = kind === 'delete' || kind === 'confirm';
	$: ok = kind === 'edit' ? true : !needsTyped ? reason.trim().length >= 5 : reason.trim().length >= 5 && typed.trim().toLowerCase() === confirmText.trim().toLowerCase();
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && dispatch('close')} />

<div class="backdrop" role="presentation" on:click={() => dispatch('close')}>
	<div class="modal" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" on:click|stopPropagation on:keydown|stopPropagation>
		<header><h3>{title}</h3><button type="button" class="x" aria-label="Close" on:click={() => dispatch('close')}>✕</button></header>
		<form method="POST" {action} data-sveltekit-reload={native ? '' : undefined} use:enhance={() => { if (native) return; busy = true; return async ({ update }) => { await update({ reset: false }); busy = false; dispatch('close'); }; }}>
			{#each Object.entries(hidden) as [k, v]}<input type="hidden" name={k} value={v} />{/each}
			<div class="body">
				<p class="lead">{body}</p>
				<div class="who"><strong>{recordName}</strong><span class="id">{recordId}</span></div>
				{#if error}<div class="adm-alert error" role="alert">{error}</div>{/if}
				{#if kind === 'edit'}
					<div class="grid">
						{#each fields as f}
							<label class:full={f.full}>{f.label}{f.required ? ' *' : ''}
								<input class="adm-input" name={f.name} type={f.type ?? 'text'} value={f.value} required={f.required} maxlength="1000" />
							</label>
						{/each}
					</div>
					<p class="hint">Saved in the app. Use "Sync to Salesforce" afterwards to push it. Edits are logged with your user ID.</p>
				{:else}
					<label>Reason (required, 5–500 characters)
						<input class="adm-input" name="reason" bind:value={reason} required minlength="5" maxlength="500" />
					</label>
					{#if needsTyped}
						<label>Type <strong class="adm-mono">{confirmText}</strong> to confirm
							<input class="adm-input" name="confirm" bind:value={typed} autocomplete="off" required />
						</label>
					{/if}
				{/if}
			</div>
			<footer>
				<button type="button" class="adm-btn outline" on:click={() => dispatch('close')}>Cancel</button>
				<button type="submit" class="adm-btn" class:danger={dangerous} disabled={!ok || busy}>{busy ? 'Working…' : submitLabel}</button>
			</footer>
		</form>
	</div>
</div>

<style>
	.backdrop { position: fixed; inset: 0; background: rgba(15,23,42,.55); z-index: 1300; display: flex; align-items: center; justify-content: center; padding: 24px; }
	.modal { background: #fff; border-radius: 12px; width: min(560px, 100%); max-height: 88vh; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 24px 80px rgba(0,0,0,.25); }
	header { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; border-bottom: 1px solid var(--grey-line); }
	h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy); }
	.x { background: none; border: none; font-size: 16px; cursor: pointer; color: var(--grey-text); }
	form { display: flex; flex-direction: column; min-height: 0; }
	.body { padding: 18px; overflow: auto; display: flex; flex-direction: column; gap: 12px; }
	.lead { margin: 0; font-size: 13px; color: var(--navy); }
	.who { display: flex; flex-direction: column; background: #F6F8FB; border-radius: 8px; padding: 8px 12px; }
	.id { font-family: ui-monospace, Menlo, monospace; font-size: 11px; color: var(--grey-text); }
	label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; font-weight: 700; color: var(--grey-text); }
	.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
	.grid .full { grid-column: 1 / -1; }
	.hint { margin: 0; font-size: 12px; color: var(--grey-text); }
	footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--grey-line); }
</style>
