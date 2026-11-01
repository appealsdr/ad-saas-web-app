<script lang="ts">
	/**
	 * Unified Required Files list + upload modal, shared by Case (issue) and
	 * Store pages. Backed by Required_File__c / S3_Document__c.
	 *
	 * Per slot: Name, short description, upload button. When uploaded: a clickable
	 * link (preview), a re-upload button, a remove button, and a file-type icon.
	 * The upload modal shows the required-file Name, the accepted file types, the
	 * upload guidelines (Instructions__c rich text, or a default), and — when the
	 * template has an example — an "Example" button to preview/download it.
	 */
	import { enhance } from '$app/forms';
	import FilePreviewModal from './FilePreviewModal.svelte';
	import { fileTypeIconUrl } from '$lib/fileIcons';

	interface RequiredFileUpload {
		localDocId: string | null; // local mirror row id (for download endpoint)
		s3DocumentId: string | null;
		fileName: string;
		fileExtension: string | null;
		contentType: string | null;
		sizeBytes: number | null;
		createdAt: string | null;
	}
	interface RequiredFileExample {
		s3DocumentId: string;
		fileName: string;
		contentType: string | null;
		fileExtension: string | null;
	}
	interface RequiredFileItem {
		id: string;
		name: string;
		shortDescription: string | null;
		instructions: string | null;
		acceptedFormats: string[];
		uploaded: boolean;
		upload: RequiredFileUpload | null;
		example: RequiredFileExample | null;
	}

	export let files: RequiredFileItem[] = [];
	export let uploadAction: string; // e.g. '?/upload_doc'
	export let clearAction: string; // e.g. '?/clear_doc'
	export let buildDownloadUrl: (localDocId: string) => string;
	export let uploadError: string | null = null;

	// ── Upload modal state ──
	let showUpload = false;
	let active: RequiredFileItem | null = null;
	let selectedFile: File | null = null;
	let dragOver = false;
	let uploading = false;
	let fileInput: HTMLInputElement;

	function openUpload(f: RequiredFileItem) {
		active = f;
		selectedFile = null;
		dragOver = false;
		showUpload = true;
	}
	function closeUpload() {
		showUpload = false;
		active = null;
		selectedFile = null;
	}
	function onPick(e: Event) {
		selectedFile = (e.target as HTMLInputElement).files?.[0] ?? null;
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		const f = e.dataTransfer?.files?.[0];
		if (f) {
			selectedFile = f;
			const dt = new DataTransfer();
			dt.items.add(f);
			fileInput.files = dt.files;
		}
	}

	$: acceptAttr = active?.acceptedFormats?.length
		? active.acceptedFormats.map((x) => '.' + x).join(',')
		: undefined;

	// ── Preview modal (shared for uploaded files + examples) ──
	let preview = { open: false, fileName: '', mimeType: null as string | null, previewUrl: '', downloadUrl: '' };
	function previewUpload(f: RequiredFileItem) {
		if (!f.upload?.localDocId) return;
		const base = buildDownloadUrl(f.upload.localDocId);
		preview = {
			open: true,
			fileName: f.upload.fileName,
			mimeType: f.upload.contentType,
			previewUrl: `${base}?disposition=inline`,
			downloadUrl: base
		};
	}
	function previewExample(ex: RequiredFileExample) {
		const base = `/api/files/example/${ex.s3DocumentId}`;
		preview = {
			open: true,
			fileName: ex.fileName,
			mimeType: ex.contentType,
			previewUrl: `${base}?disposition=inline`,
			downloadUrl: base
		};
	}

	function fmtSize(b: number | null): string {
		if (!b) return '';
		if (b < 1024) return `${b} B`;
		if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
		return `${(b / 1024 / 1024).toFixed(1)} MB`;
	}
</script>

<div class="rf-list">
	{#each files as f (f.id)}
		<div class="rf-item" class:done={f.uploaded}>
			<div class="rf-icon">
				<img src="/icons/file.png" alt="" aria-hidden="true" />
			</div>
			<div class="rf-info">
				<div class="rf-name">{f.name}</div>
				{#if f.shortDescription}<div class="rf-desc">{f.shortDescription}</div>{/if}
				{#if f.uploaded && f.upload}
					<div class="rf-meta">
						{#if f.upload.localDocId}
							<button type="button" class="rf-filelink" on:click={() => previewUpload(f)}>
								{f.upload.fileName}
							</button>
						{:else}
							<span>{f.upload.fileName}</span>
						{/if}
						{#if f.upload.sizeBytes} · {fmtSize(f.upload.sizeBytes)}{/if}
					</div>
				{/if}
			</div>
			<div class="rf-actions">
				{#if f.uploaded}
					<span class="rf-badge done">Uploaded</span>
					<button type="button" class="rf-btn" data-mutates on:click={() => openUpload(f)}>Re-upload</button>
					<form method="POST" action={clearAction} use:enhance style="display:inline">
						<input type="hidden" name="requiredFileId" value={f.id} />
						<input type="hidden" name="s3DocumentId" value={f.upload?.s3DocumentId ?? ''} />
						<button class="rf-x" type="submit" aria-label="Remove upload"
							on:click={(e) => { if (!confirm('Remove uploaded file?')) e.preventDefault(); }}>✕</button>
					</form>
				{:else}
					<span class="rf-badge pending">Pending</span>
					<button type="button" class="rf-btn primary" data-mutates on:click={() => openUpload(f)}>Upload →</button>
				{/if}
			</div>
		</div>
	{:else}
		<p class="rf-empty">No required files yet. They appear here once added in Salesforce.</p>
	{/each}
</div>

<!-- Upload modal -->
{#if showUpload && active}
	<div class="rf-overlay" on:click={closeUpload} role="presentation">
		<div class="rf-modal" on:click|stopPropagation role="dialog" aria-modal="true" aria-label="Upload document" tabindex="-1">
			<header class="rf-modal-head">
				<h3>{active.uploaded ? 'Re-upload Document' : 'Upload Document'}</h3>
				<button type="button" class="rf-modal-x" on:click={closeUpload} aria-label="Close">✕</button>
			</header>
			<div class="rf-modal-body">
				<div class="rf-slot">
					<div class="rf-slot-label">Required file</div>
					<div class="rf-slot-name">{active.name}</div>
				</div>

				<form method="POST" action={uploadAction} enctype="multipart/form-data"
					use:enhance={() => {
						uploading = true;
						return ({ update, result }) => {
							uploading = false;
							update().then(() => { if (result.type === 'success') closeUpload(); });
						};
					}}
				>
					<input type="hidden" name="requiredFileId" value={active.id} />

					<div class="rf-zone" class:drag={dragOver}
						on:click={() => fileInput.click()}
						on:dragover={(e) => { e.preventDefault(); dragOver = true; }}
						on:dragleave={() => (dragOver = false)}
						on:drop={onDrop}
						role="button" tabindex="0"
					>
						<div class="rf-zone-icon"><img src="/icons/upload.png" alt="" aria-hidden="true" /></div>
						<div class="rf-zone-title">{selectedFile ? selectedFile.name : 'Drag & drop file here'}</div>
						<div class="rf-zone-sub">
							{#if selectedFile}{fmtSize(selectedFile.size)} · ready to upload
							{:else}or <strong>click to browse</strong>{/if}
						</div>
						<input bind:this={fileInput} type="file" name="file" required on:change={onPick}
							accept={acceptAttr} style="display:none" />
					</div>

					{#if uploadError}<div class="rf-alert">{uploadError}</div>{/if}

					<!-- Supported types from Accepted_Format__c -->
					{#if active.acceptedFormats.length}
						<div class="rf-section-title">Supported File Types</div>
						<div class="rf-types">
							{#each active.acceptedFormats as ext}
								<div class="rf-type"><img src={fileTypeIconUrl(ext)} alt="" /><span>{ext.toUpperCase()}</span></div>
							{/each}
						</div>
					{/if}

					<!-- Guidelines: Instructions__c (rich text) or default -->
					<div class="rf-guide">
						<div class="rf-guide-hdr">
							<span class="rf-guide-badge"><img src="/icons/guidance.png" alt="" aria-hidden="true" /></span>
							Upload Guidelines
						</div>
						{#if active.instructions}
							<div class="rf-guide-body">{@html active.instructions}</div>
						{:else}
							<ul>
								<li>Maximum file size: <strong>25 MB per file</strong></li>
								<li>Upload <strong>unedited originals</strong> — clear and fully readable</li>
								<li>Files are encrypted in transit and stored in Amazon S3 (AES-256)</li>
							</ul>
						{/if}
					</div>

					<div class="rf-modal-actions">
						<button type="submit" class="rf-submit" disabled={uploading || !selectedFile}>
							{uploading ? 'Uploading…' : 'Upload File'}
						</button>
						{#if active.example}
							<button type="button" class="rf-ghost" on:click={() => active && active.example && previewExample(active.example)}>Example</button>
						{/if}
						<button type="button" class="rf-ghost" on:click={closeUpload} disabled={uploading}>Cancel</button>
					</div>
				</form>
			</div>
		</div>
	</div>
{/if}

<FilePreviewModal
	bind:open={preview.open}
	fileName={preview.fileName}
	mimeType={preview.mimeType}
	previewUrl={preview.previewUrl}
	downloadUrl={preview.downloadUrl}
/>

<style>
	.rf-list { display: flex; flex-direction: column; gap: 8px; }
	.rf-item {
		display: flex; align-items: flex-start; gap: 12px;
		padding: 12px 14px; border: 1px solid var(--grey-line); border-radius: 10px;
		background: #fff;
	}
	.rf-item.done { background: var(--grey-bg); }
	.rf-icon {
		width: 36px; height: 36px; flex-shrink: 0; display: flex; align-items: center;
		justify-content: center; background: var(--navy-dark); border-radius: 9px;
	}
	.rf-icon img { width: 18px; height: 18px; object-fit: contain; }
	.rf-info { flex: 1; min-width: 0; }
	.rf-name { font-weight: 700; color: var(--navy); font-size: 14px; }
	.rf-desc { font-size: 12px; color: var(--grey-text); margin-top: 2px; }
	.rf-meta { font-size: 12px; color: var(--grey-text); margin-top: 4px; }
	.rf-filelink {
		background: none; border: none; padding: 0; font: inherit;
		color: var(--orange); text-decoration: underline; cursor: pointer;
	}
	.rf-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
	.rf-badge { font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 3px 8px; border-radius: 10px; }
	.rf-badge.done { background: var(--green-lt); color: #15803d; }
	.rf-badge.pending { background: var(--yellow-lt); color: #92400e; }
	.rf-btn {
		background: #fff; border: 1px solid var(--grey-line); border-radius: 8px;
		padding: 6px 11px; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer;
	}
	.rf-btn.primary { background: var(--orange); color: #fff; border-color: var(--orange); }
	.rf-x { background: none; border: none; color: var(--grey-text); cursor: pointer; font-size: 13px; padding: 4px; }
	.rf-empty { color: var(--grey-text); font-size: 13px; }

	.rf-overlay {
		position: fixed; inset: 0; background: rgba(17, 29, 51, .6);
		display: flex; align-items: center; justify-content: center; z-index: 1000; padding: 24px;
	}
	.rf-modal {
		background: #fff; border-radius: 14px; width: min(560px, 100%); max-height: 88vh;
		display: flex; flex-direction: column; overflow: hidden; box-shadow: var(--shadow-xl);
	}
	.rf-modal-head {
		display: flex; align-items: center; justify-content: space-between;
		padding: 14px 18px; border-bottom: 1px solid var(--grey-line);
	}
	.rf-modal-head h3 { margin: 0; font-size: 16px; font-weight: 800; color: var(--navy); }
	.rf-modal-x { background: none; border: none; font-size: 15px; cursor: pointer; color: var(--grey-text); }
	.rf-modal-body { padding: 18px; overflow: auto; }
	.rf-slot { background: var(--grey-bg); border-radius: 9px; padding: 10px 13px; margin-bottom: 14px; }
	.rf-slot-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); }
	.rf-slot-name { font-weight: 700; color: var(--navy); }

	.rf-zone {
		border: 2px dashed var(--grey-line); border-radius: 12px; padding: 28px 20px;
		text-align: center; cursor: pointer; transition: all .2s; margin-bottom: 16px;
	}
	.rf-zone.drag, .rf-zone:hover { border-color: var(--orange); background: var(--orange-lt); }
	.rf-zone-icon {
		width: 56px; height: 56px; margin: 0 auto 12px; background: var(--navy-dark);
		border-radius: 14px; display: flex; align-items: center; justify-content: center;
	}
	.rf-zone-icon img { width: 28px; height: 28px; object-fit: contain; }
	.rf-zone-title { font-size: 15px; font-weight: 700; color: var(--navy); margin-bottom: 4px; }
	.rf-zone-sub { font-size: 13px; color: var(--grey-text); }
	.rf-zone-sub strong { color: var(--orange); }

	.rf-alert { background: var(--red-lt); color: #b91c1c; border-radius: 8px; padding: 9px 12px; font-size: 13px; margin-bottom: 14px; }

	.rf-section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); margin-bottom: 10px; }
	.rf-types { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-bottom: 16px; }
	.rf-type { background: var(--grey-bg); border-radius: 8px; padding: 9px 6px; text-align: center; }
	.rf-type img { width: 24px; height: 24px; object-fit: contain; display: block; margin: 0 auto 4px; }
	.rf-type span { font-size: 10px; font-weight: 700; color: var(--navy); }

	.rf-guide { background: var(--grey-bg); border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; font-size: 13px; }
	.rf-guide-hdr { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 10px; color: var(--navy); }
	.rf-guide-badge { width: 28px; height: 28px; flex-shrink: 0; background: var(--navy-dark); border-radius: 8px; display: flex; align-items: center; justify-content: center; }
	.rf-guide-badge img { width: 16px; height: 16px; object-fit: contain; }
	.rf-guide-body :global(p) { margin: 0 0 6px; }
	.rf-guide-body :global(ul), .rf-guide :global(ul) { margin: 0; padding-left: 18px; }
	.rf-guide :global(li) { margin-bottom: 4px; }

	.rf-modal-actions { display: flex; gap: 10px; }
	.rf-submit {
		flex: 1; background: var(--orange); color: #fff; border: none; border-radius: 9px;
		padding: 12px; font-size: 14px; font-weight: 700; cursor: pointer;
	}
	.rf-submit:disabled { opacity: .5; cursor: not-allowed; }
	.rf-ghost { background: #fff; border: 1px solid var(--grey-line); border-radius: 9px; padding: 12px 18px; font-size: 14px; font-weight: 600; color: var(--navy); cursor: pointer; }
</style>
