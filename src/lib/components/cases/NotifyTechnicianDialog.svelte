<script lang="ts">
	/**
	 * "Thank you for your reply" — Cancel or Notify technician. Shown after a client action that leaves
	 * nothing outstanding, and from the button beside a waiting case's status. Hosts mount it to open it.
	 * Only "Notify technician" changes anything: it posts `action`, which moves the case on.
	 */
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';

	/** The host route's notify_technician action. */
	export let action: string;
	export let onClose: () => void;
	/** Receives the confirmation text once the technician has been notified. */
	export let onNotified: (message: string) => void = () => {};
	/** Reloads the data so the new status shows. */
	export let onRefresh: () => Promise<unknown> = invalidateAll;

	let sending = false;
	let error: string | null = null;

	/** A native modal dialog: it traps focus, closes on Escape and sits above other overlays. */
	function modal(node: HTMLDialogElement) {
		const returnTo = document.activeElement as HTMLElement | null;
		node.showModal();
		return {
			destroy() {
				node.close();
				returnTo?.focus?.();
			}
		};
	}
</script>

<dialog
	use:modal
	aria-labelledby="notify-title"
	aria-describedby="notify-text"
	on:cancel|preventDefault={() => !sending && onClose()}
>
	<h3 id="notify-title">Thank you for your reply</h3>
	<p id="notify-text">Would you like to notify the technician? The case will move to In Progress - Tech.</p>
	{#if error}<div class="alert alert-error" role="alert">{error}</div>{/if}
	<form
		method="POST"
		{action}
		use:enhance={() => {
			sending = true;
			error = null;
			// The result stays here: the page's own form state is left as it was.
			return async ({ result }) => {
				if (result.type === 'success') {
					await onRefresh();
					sending = false;
					onNotified(String(result.data?.notifySuccess ?? 'The technician has been notified.'));
					onClose();
					return;
				}
				sending = false;
				error = String(
					(result.type === 'failure' && result.data?.notifyError) || 'Could not notify the technician. Please try again.'
				);
			};
		}}
	>
		<button type="button" class="btn btn-outline" disabled={sending} on:click={onClose}>Cancel</button>
		<button type="submit" class="btn btn-primary" data-mutates disabled={sending}>
			{sending ? 'Notifying…' : 'Notify technician'}
		</button>
	</form>
</dialog>

<style>
	dialog {
		width: min(420px, calc(100vw - 32px)); margin: auto; padding: 22px 24px;
		border: 0; border-radius: var(--radius); background: white; color: var(--navy);
		box-shadow: 0 20px 60px rgba(0,0,0,.25);
	}
	dialog::backdrop { background: rgba(15, 23, 42, .55); }
	h3 { margin: 0 0 8px; font-size: 17px; font-weight: 700; }
	p { margin: 0 0 18px; font-size: 14px; color: var(--grey-text); }
	.alert { margin-bottom: 14px; }
	form { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; }
</style>
