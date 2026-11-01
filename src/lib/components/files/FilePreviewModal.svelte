<script lang="ts">
	/**
	 * In-app file preview modal. Renders the file inline by type (image, PDF,
	 * video, audio, text) using an inline presigned URL; falls back to a
	 * download prompt for unsupported types.
	 *
	 * `previewUrl` should point at the document endpoint with ?disposition=inline,
	 * `downloadUrl` at the same endpoint without it.
	 */
	export let open = false;
	export let fileName = '';
	export let mimeType: string | null = null;
	export let previewUrl = '';
	export let downloadUrl = '';

	function close() {
		open = false;
	}

	type Kind = 'image' | 'pdf' | 'video' | 'audio' | 'text' | 'none';

	function previewKind(mime: string | null, name: string): Kind {
		const m = (mime ?? '').toLowerCase();
		const ext = name.toLowerCase().split('.').pop() ?? '';
		if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext))
			return 'image';
		if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
		if (m.startsWith('video/') || ['mp4', 'webm', 'mov', 'm4v'].includes(ext)) return 'video';
		if (m.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a'].includes(ext)) return 'audio';
		if (m.startsWith('text/') || ['txt', 'csv', 'log', 'json', 'md'].includes(ext)) return 'text';
		return 'none';
	}

	$: kind = previewKind(mimeType, fileName);

	function onKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') close();
	}
</script>

<svelte:window on:keydown={onKeydown} />

{#if open}
	<div class="overlay" on:click={close} role="presentation">
		<div
			class="modal"
			on:click|stopPropagation
			role="dialog"
			aria-modal="true"
			aria-label={`Preview of ${fileName}`}
			tabindex="-1"
		>
			<header class="head">
				<span class="name" title={fileName}>{fileName}</span>
				<div class="actions">
					<a class="btn btn-outline btn-sm" href={downloadUrl} target="_blank" rel="noopener">
						⬇ Download
					</a>
					<button class="btn btn-outline btn-sm" type="button" on:click={close} aria-label="Close preview">
						✕
					</button>
				</div>
			</header>

			<div class="body">
				{#if !previewUrl}
					<p class="msg">No file to preview.</p>
				{:else if kind === 'image'}
					<img src={previewUrl} alt={fileName} />
				{:else if kind === 'pdf' || kind === 'text'}
					<iframe src={previewUrl} title={`Preview of ${fileName}`}></iframe>
				{:else if kind === 'video'}
					<!-- svelte-ignore a11y-media-has-caption -->
					<video src={previewUrl} controls>Your browser cannot play this video.</video>
				{:else if kind === 'audio'}
					<audio src={previewUrl} controls>Your browser cannot play this audio.</audio>
				{:else}
					<div class="noprev">
						<p class="msg">Preview isn't available for this file type.</p>
						<a class="btn btn-primary" href={downloadUrl} target="_blank" rel="noopener">
							Download {fileName}
						</a>
					</div>
				{/if}
			</div>
		</div>
	</div>
{/if}

<style>
	.overlay {
		position: fixed;
		inset: 0;
		background: rgba(15, 23, 42, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 1000;
		padding: 24px;
	}
	.modal {
		background: #fff;
		border-radius: 12px;
		width: min(960px, 100%);
		height: min(85vh, 100%);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		box-shadow: var(--shadow-xl, 0 20px 60px rgba(0, 0, 0, 0.3));
	}
	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 12px 16px;
		border-bottom: 1px solid var(--grey-line, #e5e7eb);
	}
	.name {
		font-weight: 700;
		color: var(--navy, #1f3864);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-shrink: 0;
	}
	.body {
		flex: 1;
		min-height: 0;
		background: #f8fafc;
		display: flex;
		align-items: center;
		justify-content: center;
		overflow: auto;
	}
	.body img {
		max-width: 100%;
		max-height: 100%;
		object-fit: contain;
	}
	.body iframe {
		width: 100%;
		height: 100%;
		border: 0;
		background: #fff;
	}
	.body video {
		max-width: 100%;
		max-height: 100%;
	}
	.noprev {
		text-align: center;
		padding: 32px;
	}
	.msg {
		color: var(--grey-text, #64748b);
		margin-bottom: 16px;
	}
</style>
