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
	import { enhance, deserialize, applyAction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
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
		/** Every upload in the slot, newest first (only filled where multi-file is supported). */
		uploads?: RequiredFileUpload[];
		example: RequiredFileExample | null;
	}

	export let files: RequiredFileItem[] = [];
	export let uploadAction: string; // e.g. '?/upload_doc'
	export let clearAction: string; // e.g. '?/clear_doc'
	export let buildDownloadUrl: (localDocId: string) => string;
	export let uploadError: string | null = null;
	/** Allow several files per required file (needs server support: `docId` on clear, many `file` parts on upload). */
	export let multiple = false;
	/** Shown in the upload screen's breadcrumb, e.g. "Case 00012418". */
	export let contextLabel = 'Documents';
	/** Max files shown per required file in the list; the rest are behind "+N more" (opens the upload screen). */
	export let previewLimit: number | null = null;

	const MAX_FILE_BYTES = 25 * 1024 * 1024;

	// ── Upload screen state ──
	let showUpload = false;
	let activeId: string | null = null;
	let selectedFiles: File[] = [];
	let dragOver = false;
	let uploading = false;
	/** Upload progress shown in the "Checking your document" panel. */
	let phase: 'uploading' | 'saving' = 'uploading';
	let progress = 0;
	let fileInput: HTMLInputElement;
	/** Slot already has files: false shows the file list, true shows the drop zone. */
	let adding = false;
	/** Set by "New version": the upload replaces this file. */
	let replaceDocId: string | null = null;

	$: active = files.find((x) => x.id === activeId) ?? null;
	$: uploadedCount = files.filter((x) => x.uploaded).length;
	$: oversize = selectedFiles.filter((x) => x.size > MAX_FILE_BYTES);
	$: slotUploads = active ? uploadsOf(active) : [];

	function uploadsOf(f: RequiredFileItem): RequiredFileUpload[] {
		if (multiple && f.uploads?.length) return f.uploads;
		return f.upload ? [f.upload] : [];
	}

	function openUpload(f: RequiredFileItem) {
		selectSlot(f);
		showUpload = true;
	}
	function selectSlot(f: RequiredFileItem) {
		activeId = f.id;
		selectedFiles = [];
		syncInput();
		dragOver = false;
		adding = false;
		replaceDocId = null;
	}
	const STEPS = [
		'Uploading your file',
		'Saving securely and linking it to your case',
		'Done'
	];
	$: stepIndex = phase === 'uploading' ? 0 : 1;
	$: batchLabel = selectedFiles.length === 1
		? `${selectedFiles[0].name} · ${fmtSize(selectedFiles[0].size)}`
		: `${selectedFiles.length} files · ${fmtSize(selectedFiles.reduce((n, x) => n + x.size, 0))}`;

	/**
	 * POST the form ourselves (not via use:enhance) so we get byte-level upload
	 * progress from XHR. The response is handled like enhance's default update().
	 */
	function submitUpload(e: SubmitEvent) {
		e.preventDefault();
		if (uploading || !selectedFiles.length) return;
		const form = e.currentTarget as HTMLFormElement;
		const body = new FormData(form);

		uploading = true;
		phase = 'uploading';
		progress = 0;

		const xhr = new XMLHttpRequest();
		xhr.open('POST', uploadAction);
		xhr.setRequestHeader('x-sveltekit-action', 'true');
		xhr.setRequestHeader('accept', 'application/json');
		xhr.upload.onprogress = (ev) => {
			if (ev.lengthComputable) progress = Math.round((ev.loaded / ev.total) * 100);
		};
		xhr.upload.onload = () => {
			progress = 100;
			phase = 'saving'; // bytes are with the server; it now stores + registers them
		};
		xhr.onerror = xhr.ontimeout = () => {
			uploading = false;
			applyAction({ type: 'failure', status: 0, data: { uploadError: 'Network error. Please try again.' } });
		};
		xhr.onload = async () => {
			let result;
			try {
				result = deserialize(xhr.responseText);
			} catch {
				result = { type: 'failure' as const, status: xhr.status, data: { uploadError: 'Unexpected response from the server.' } };
			}
			if (result.type === 'success') await invalidateAll();
			uploading = false;
			await applyAction(result);
			if (result.type === 'success') closeUpload();
		};
		xhr.send(body);
	}

	function startAdding(replace: string | null = null) {
		replaceDocId = replace;
		adding = true;
	}
	function cancelAdding() {
		adding = false;
		replaceDocId = null;
		selectedFiles = [];
		syncInput();
	}
	$: showDropZone = !!active && (slotUploads.length === 0 || adding);

	function fileExt(name: string): string {
		const m = /\.([A-Za-z0-9]+)$/.exec(name);
		return m ? m[1].toLowerCase() : '';
	}
	function fmtUploaded(iso: string | null): string {
		if (!iso) return '';
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return '';
		return (
			d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
			' at ' +
			d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase()
		);
	}
	function closeUpload() {
		if (uploading) return;
		showUpload = false;
		activeId = null;
		selectedFiles = [];
		adding = false;
		replaceDocId = null;
	}
	function syncInput() {
		if (!fileInput) return;
		const dt = new DataTransfer();
		for (const x of selectedFiles) dt.items.add(x);
		fileInput.files = dt.files;
	}
	function addFiles(list: FileList | File[] | null | undefined) {
		const incoming = Array.from(list ?? []);
		if (!incoming.length) return;
		selectedFiles = multiple ? [...selectedFiles, ...incoming] : [incoming[0]];
		syncInput();
	}
	function removeSelected(i: number) {
		selectedFiles = selectedFiles.filter((_, idx) => idx !== i);
		syncInput();
	}
	function onPick(e: Event) {
		const input = e.target as HTMLInputElement;
		// The input is the source of truth for the browse dialog; fold its picks
		// into our list (so repeat browsing adds instead of replaces).
		const picked = Array.from(input.files ?? []);
		selectedFiles = multiple ? [...selectedFiles.filter((x) => !picked.includes(x)), ...picked] : picked.slice(0, 1);
		syncInput();
	}
	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragOver = false;
		addFiles(e.dataTransfer?.files);
	}
	function onKeydownDrop(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			fileInput.click();
		}
	}

	$: acceptAttr = active?.acceptedFormats?.length
		? active.acceptedFormats.map((x) => '.' + x).join(',')
		: undefined;

	// ── Preview modal (shared for uploaded files + examples) ──
	let preview = { open: false, fileName: '', mimeType: null as string | null, previewUrl: '', downloadUrl: '' };
	function previewUpload(u: RequiredFileUpload | null) {
		if (!u?.localDocId) return;
		const base = buildDownloadUrl(u.localDocId);
		preview = {
			open: true,
			fileName: u.fileName,
			mimeType: u.contentType,
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
		{@const ups = uploadsOf(f)}
		<div class="rf-item" class:done={f.uploaded}>
			<div class="rf-icon">
				<img src="/icons/file.png" alt="" aria-hidden="true" />
			</div>
			<div class="rf-info">
				<div class="rf-name-row">
					<button type="button" class="rf-name-btn" title="Open documents" on:click={() => openUpload(f)}>{f.name}</button>
					{#if ups.length}<span class="rf-count" title={`${ups.length} uploaded file${ups.length === 1 ? '' : 's'}`}>{ups.length}</span>{/if}
				</div>
				{#if f.shortDescription}<div class="rf-desc">{f.shortDescription}</div>{/if}
			</div>
			<div class="rf-actions">
				{#if f.uploaded}
					<span class="rf-badge done">Uploaded</span>
					<button type="button" class="rf-btn" data-mutates on:click={() => openUpload(f)}>
						{multiple ? 'Add files' : 'Re-upload'}
					</button>
					{#if !multiple}
						<form method="POST" action={clearAction} use:enhance style="display:inline">
							<input type="hidden" name="requiredFileId" value={f.id} />
							<input type="hidden" name="s3DocumentId" value={f.upload?.s3DocumentId ?? ''} />
							<button class="rf-x" type="submit" aria-label="Remove upload"
								on:click={(e) => { if (!confirm('Remove uploaded file?')) e.preventDefault(); }}>✕</button>
						</form>
					{/if}
				{:else}
					<span class="rf-badge pending">Pending</span>
					<button type="button" class="rf-btn primary" data-mutates on:click={() => openUpload(f)}>Upload →</button>
				{/if}
			</div>
			{#if ups.length}
				<div class="rf-files">
				{#each previewLimit === null ? ups : ups.slice(0, previewLimit) as u (u.localDocId ?? u.fileName)}
						<div class="rf-meta">
							<div class="rf-chip-wrap" class:static={!u.localDocId}>
								{#if u.localDocId}
									<button type="button" class="rf-chip" title="Preview file" on:click={() => previewUpload(u)}>
										<img class="rf-chip-icon" src={fileTypeIconUrl(fileExt(u.fileName))} alt="" />
										<span class="rf-chip-name">{u.fileName}</span>
										{#if u.sizeBytes}<span class="rf-chip-size">{fmtSize(u.sizeBytes)}</span>{/if}
										<svg class="rf-chip-eye" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"></path><circle cx="12" cy="12" r="3"></circle></svg>
									</button>
								{:else}
									<span class="rf-chip">
										<img class="rf-chip-icon" src={fileTypeIconUrl(fileExt(u.fileName))} alt="" />
										<span class="rf-chip-name">{u.fileName}</span>
										{#if u.sizeBytes}<span class="rf-chip-size">{fmtSize(u.sizeBytes)}</span>{/if}
									</span>
								{/if}
								{#if multiple && u.localDocId}
									<form method="POST" action={clearAction} use:enhance style="display:inline-flex">
										<input type="hidden" name="requiredFileId" value={f.id} />
										<input type="hidden" name="s3DocumentId" value={u.s3DocumentId ?? f.upload?.s3DocumentId ?? ''} />
										<input type="hidden" name="docId" value={u.localDocId} />
										<button class="rf-chip-x" type="submit" title="Remove file" aria-label={`Remove ${u.fileName}`}
											on:click={(e) => { if (!confirm(`Remove ${u.fileName}?`)) e.preventDefault(); }}>✕</button>
									</form>
								{/if}
							</div>
						</div>
					{/each}
					{#if previewLimit !== null && ups.length > previewLimit}
						<button type="button" class="rf-more" on:click={() => openUpload(f)}>
							+ {ups.length - previewLimit} more file{ups.length - previewLimit === 1 ? '' : 's'}
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{:else}
		<p class="rf-empty">No required files yet. They appear here once added in Salesforce.</p>
	{/each}
</div>

<!-- Upload screen — fills the content area (right of the sidebar, below the topbar) -->
{#if showUpload && active}
	<div class="rf-screen" role="dialog" aria-modal="true" aria-label="Upload document">
		<div class="rf-screen-head">
			<div class="rf-screen-titles">
				<nav class="rf-crumbs" aria-label="Breadcrumb">
					<button type="button" class="rf-crumb-link" on:click={closeUpload}>{contextLabel}</button><span>/</span>
					<span class="rf-crumb-current">Case Documents</span>
				</nav>
				<h2>{active.uploaded && !multiple ? 'Re-upload Document' : 'Upload Document'}</h2>
			</div>
			<button type="button" class="rf-close" on:click={closeUpload} disabled={uploading} aria-label="Close" title="Close">✕</button>
		</div>

		<div class="rf-screen-grid">
			<aside class="rf-side">
				<div class="rf-side-head">
					Required files
					<span>{uploadedCount} of {files.length} uploaded</span>
				</div>
				<div class="rf-side-list">
					{#each files as f (f.id)}
						<button type="button" class="rf-side-item" class:active={f.id === activeId}
							disabled={uploading} on:click={() => selectSlot(f)}>
							<span class="rf-side-name">{f.name}</span>
							{#if uploadsOf(f).length}<span class="rf-count">{uploadsOf(f).length}</span>{/if}
							<span class="rf-badge" class:done={f.uploaded} class:pending={!f.uploaded}>
								{f.uploaded ? 'Uploaded' : 'Pending'}
							</span>
						</button>
					{/each}
				</div>
			</aside>

			<section class="rf-panel">
				<div class="rf-panel-head">
					<div class="rf-slot-label">Required file</div>
					<div class="rf-panel-title">
						<span>{active.name}</span>
						{#if uploading}
							<span class="rf-badge checking">{phase === 'uploading' ? 'Uploading' : 'Saving'}</span>
						{:else}
							<span class="rf-badge" class:done={active.uploaded} class:pending={!active.uploaded}>
								{active.uploaded ? 'Uploaded' : 'Pending'}
							</span>
						{/if}
					</div>
					{#if active.shortDescription}<div class="rf-panel-desc">{active.shortDescription}</div>{/if}
					{#if uploading}<div class="rf-panel-file">{batchLabel}</div>{/if}
				</div>

				{#if !uploading && !showDropZone}
					<div class="rf-uploaded-view">
						<div class="rf-uploaded-head">
							<div class="rf-section-title" style="margin:0">Uploaded files · {slotUploads.length}</div>
							{#if multiple}
								<button type="button" class="rf-outline-btn" on:click={() => startAdding()}>+ Add more files</button>
							{/if}
						</div>
						{#each slotUploads as u (u.localDocId ?? u.fileName)}
							<div class="rf-file-card">
								<img class="rf-file-icon" src={fileTypeIconUrl(fileExt(u.fileName))} alt="" />
								<button type="button" class="rf-file-main" title="Open preview" on:click={() => previewUpload(u)}>
									<span class="rf-file-name">{u.fileName}</span>
									<span class="rf-file-meta">
										{fileExt(u.fileName).toUpperCase()}{u.sizeBytes ? ` · ${fmtSize(u.sizeBytes)}` : ''}{u.createdAt ? ` · Uploaded ${fmtUploaded(u.createdAt)}` : ''}
									</span>
								</button>
								<div class="rf-file-actions">
									<button type="button" class="rf-outline-btn sm" title="Upload a new version of this file"
										on:click={() => startAdding(u.localDocId)}>New version</button>
									<form method="POST" action={clearAction} use:enhance style="display:inline">
										<input type="hidden" name="requiredFileId" value={active.id} />
										<input type="hidden" name="s3DocumentId" value={u.s3DocumentId ?? active.upload?.s3DocumentId ?? ''} />
										{#if multiple}<input type="hidden" name="docId" value={u.localDocId ?? ''} />{/if}
										<button type="submit" class="rf-trash" title="Delete file" aria-label="Delete file"
											on:click={(e) => { if (!confirm(`Delete ${u.fileName}?`)) e.preventDefault(); }}>
											<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"></path></svg>
										</button>
									</form>
								</div>
							</div>
						{/each}
						<div class="rf-modal-actions">
							<button type="button" class="rf-ghost" on:click={closeUpload}>Back to case</button>
						</div>
					</div>
				{/if}

				{#if uploading}
					<div class="rf-checking" role="status" aria-live="polite">
						<div class="rf-checking-title">Checking your document</div>
						{#each STEPS as label, i}
							{@const done = i < stepIndex}
							{@const cur = i === stepIndex}
							<div class="rf-step" class:done class:cur>
								<span class="rf-step-dot">{done ? '✓' : i + 1}</span>
								<span class="rf-step-label">
									{label}{#if cur && i === 0} · {progress}%{/if}
								</span>
							</div>
						{/each}
						<div class="rf-bar" aria-hidden="true"><div class="rf-bar-fill" style:width={`${phase === 'uploading' ? progress : 100}%`}></div></div>
					</div>
				{/if}

				{#if showDropZone || uploading}
				<form method="POST" action={uploadAction} enctype="multipart/form-data"
					on:submit={submitUpload} style:display={uploading ? 'none' : undefined}
				>
					<input type="hidden" name="requiredFileId" value={active.id} />
					{#if replaceDocId}<input type="hidden" name="replaceDocId" value={replaceDocId} />{/if}

					<div class="rf-zone" class:drag={dragOver}
						on:click={() => fileInput.click()}
						on:keydown={onKeydownDrop}
						on:dragover={(e) => { e.preventDefault(); dragOver = true; }}
						on:dragleave={() => (dragOver = false)}
						on:drop={onDrop}
						role="button" tabindex="0"
					>
						<div class="rf-zone-icon"><img src="/icons/upload.png" alt="" aria-hidden="true" /></div>
						<div class="rf-zone-title">{multiple ? 'Drag & drop files here' : 'Drag & drop file here'}</div>
						<div class="rf-zone-sub">
							{#if multiple}You can select multiple files · or{:else}or{/if}{' '}<strong>click to browse</strong>
						</div>
						<input bind:this={fileInput} type="file" name="file" {multiple} required on:change={onPick}
							accept={acceptAttr} style="display:none" />
					</div>

					{#if selectedFiles.length}
						<ul class="rf-picked">
							{#each selectedFiles as sf, i (sf.name + sf.size + sf.lastModified)}
								<li class:bad={sf.size > MAX_FILE_BYTES}>
									<span class="rf-picked-name">{sf.name}</span>
									<span class="rf-picked-size">
										{fmtSize(sf.size)}{#if sf.size > MAX_FILE_BYTES} · over 25 MB{/if}
									</span>
									<button type="button" class="rf-x" aria-label={`Remove ${sf.name}`} disabled={uploading}
										on:click={() => removeSelected(i)}>✕</button>
								</li>
							{/each}
						</ul>
					{/if}

					{#if uploadError}<div class="rf-alert">{uploadError}</div>{/if}

					<div class="rf-info-grid">
						<!-- Supported types from Accepted_Format__c -->
						{#if active.acceptedFormats.length}
							<div>
								<div class="rf-section-title">Supported File Types</div>
								<div class="rf-types">
									{#each active.acceptedFormats as ext}
										<div class="rf-type"><img src={fileTypeIconUrl(ext)} alt="" /><span>{ext.toUpperCase()}</span></div>
									{/each}
								</div>
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
					</div>

					<div class="rf-modal-actions">
						{#if active.example}
							<button type="button" class="rf-ghost left" on:click={() => active && active.example && previewExample(active.example)}>View example</button>
						{/if}
						<button type="button" class="rf-ghost" on:click={slotUploads.length ? cancelAdding : closeUpload} disabled={uploading}>Cancel</button>
						<button type="submit" class="rf-submit" disabled={uploading || !selectedFiles.length || oversize.length > 0}>
							{uploading ? 'Uploading…' : selectedFiles.length > 1 ? `Upload ${selectedFiles.length} Files` : replaceDocId ? 'Upload New Version' : 'Upload File'}
						</button>
					</div>
				</form>
				{/if}
			</section>
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
	.rf-item { position: relative; flex-wrap: wrap; }
	.rf-more { align-self: flex-start; background: none; border: none; padding: 2px 4px; font: inherit; font-size: 12px; font-weight: 600; color: var(--orange); cursor: pointer; }
	.rf-more:hover { text-decoration: underline; }
	.rf-files { flex: 1 1 100%; min-width: 0; max-width: 100%; display: flex; flex-direction: column; gap: 6px; position: relative; z-index: 1; }
	.rf-item.done { background: var(--grey-bg); }
	.rf-item:hover { border-color: var(--orange); }
	/* Stretched link: the name button's ::after covers the whole row so a click
	   anywhere opens the documents screen; chips, forms and buttons sit above it. */
	.rf-name-row { display: flex; align-items: center; gap: 8px; }
	.rf-count {
		position: relative; z-index: 1; flex-shrink: 0; min-width: 20px; height: 20px; padding: 0 6px;
		display: inline-flex; align-items: center; justify-content: center; border-radius: 999px;
		background: var(--navy); color: #fff; font-size: 11px; font-weight: 700; line-height: 1;
	}
	.rf-name-btn {
		display: block; text-align: left; background: none; border: none; padding: 0;
		font: inherit; font-weight: 700; color: var(--navy); font-size: 14px; cursor: pointer;
	}
	.rf-name-btn::after { content: ''; position: absolute; inset: 0; border-radius: 10px; }
	.rf-name-btn:focus-visible::after { outline: 2px solid var(--orange); }
	.rf-meta { position: relative; z-index: 1; width: 100%; min-width: 0; }
	.rf-chip-wrap {
		display: flex; align-items: center; width: 100%; min-width: 0; box-sizing: border-box;
		border-radius: 999px; background: #fff; border: 1px solid var(--grey-line);
		padding-right: 4px;
	}
	.rf-chip-wrap:hover { border-color: var(--orange); }
	.rf-chip-wrap.static, .rf-chip-wrap.static:hover { border-color: var(--grey-line); }
	.rf-chip {
		display: flex; align-items: center; gap: 7px; flex: 1; min-width: 0;
		padding: 4px 6px 4px 8px; background: none; border: none; color: var(--navy);
		font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
	}
	span.rf-chip { cursor: default; }
	.rf-chip-x {
		width: 22px; height: 22px; flex-shrink: 0; display: inline-flex; align-items: center;
		justify-content: center; padding: 0; border: none; border-radius: 50%;
		background: none; color: var(--grey-text); font-size: 12px; cursor: pointer;
	}
	.rf-chip-x:hover { background: var(--red-lt); color: #b91c1c; }
	.rf-chip-icon { width: 16px; height: 16px; object-fit: contain; flex-shrink: 0; }
	.rf-chip-name { flex: 1 1 0; min-width: 0; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rf-chip-size { color: var(--grey-text); font-weight: 500; flex-shrink: 0; white-space: nowrap; }
	.rf-chip-eye { color: var(--grey-text); flex-shrink: 0; }
	.rf-chip-wrap:hover .rf-chip-eye { color: var(--orange); }
	.rf-icon {
		width: 36px; height: 36px; flex-shrink: 0; display: flex; align-items: center;
		justify-content: center; background: var(--navy-dark); border-radius: 9px;
	}
	.rf-icon img { width: 18px; height: 18px; object-fit: contain; }
	.rf-info { flex: 1; min-width: 0; }
	.rf-desc { font-size: 12px; color: var(--grey-text); margin-top: 2px; }
	.rf-meta { font-size: 12px; color: var(--grey-text); }
	.rf-actions { position: relative; z-index: 1; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
	.rf-badge { display: inline-block; min-width: 72px; text-align: center; box-sizing: border-box; font-size: 10px; font-weight: 700; text-transform: uppercase; padding: 3px 8px; border-radius: 10px; }
	.rf-badge.done { background: var(--green-lt); color: #15803d; }
	.rf-badge.pending { background: var(--yellow-lt); color: #92400e; }
	.rf-btn {
		background: #fff; border: 1px solid var(--grey-line); border-radius: 8px;
		padding: 6px 11px; font-size: 12px; font-weight: 600; color: var(--navy); cursor: pointer;
	}
	.rf-btn.primary { background: var(--orange); color: #fff; border-color: var(--orange); }
	.rf-x { background: none; border: none; color: var(--grey-text); cursor: pointer; font-size: 13px; padding: 4px; }
	.rf-empty { color: var(--grey-text); font-size: 13px; }

	/* Upload screen (Case Detail reference): fills the area right of the 72px sidebar and below the topbar. */
	.rf-screen {
		position: fixed; inset: var(--topbar-h) 0 0 72px; background: var(--grey-bg);
		z-index: 900; overflow-y: auto; padding: 22px 26px;
	}
	.rf-screen-head {
		display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
		gap: 12px; margin-bottom: 14px;
	}
	.rf-screen-titles { min-width: 0; }
	.rf-screen-head h2 { margin: 0; font-size: 21px; line-height: 1.3; font-weight: 700; color: var(--navy); }
	.rf-crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--grey-text); margin-bottom: 4px; }
	.rf-crumb-link { background: none; border: none; padding: 0; font: inherit; color: var(--grey-text); cursor: pointer; }
	.rf-crumb-link:hover { text-decoration: underline; }
	.rf-crumb-current { color: var(--navy); font-weight: 600; }
	.rf-close {
		width: 32px; height: 32px; display: inline-flex; align-items: center; justify-content: center;
		padding: 0; font-size: 15px; line-height: 1; border-radius: 50%; border: none;
		background: #f3f4f6; color: var(--navy); cursor: pointer;
	}
	.rf-screen-grid { display: grid; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: 20px; align-items: start; }
	@media (max-width: 900px) { .rf-screen-grid { grid-template-columns: 1fr; } }

	.rf-side { background: #fff; border: 1px solid var(--grey-line); border-radius: 12px; padding: 16px; }
	.rf-side-head {
		display: flex; align-items: center; justify-content: space-between; gap: 10px;
		font-size: 14px; font-weight: 700; color: var(--navy);
		margin-bottom: 12px; padding-bottom: 10px; border-bottom: 1px solid var(--grey-line);
	}
	.rf-side-head span { font-size: 11px; font-weight: 500; color: var(--grey-text); }
	.rf-side-list { display: flex; flex-direction: column; gap: 8px; }
	.rf-side-item {
		text-align: left; width: 100%; padding: 10px 12px; border-radius: 9px; cursor: pointer;
		display: flex; align-items: center; gap: 10px; color: var(--navy);
		border: 1px solid var(--grey-line); background: #fff; font-family: inherit;
	}
	.rf-side-item.active { border-color: var(--orange); background: var(--orange-lt); }
	.rf-side-item:disabled { cursor: not-allowed; opacity: .7; }
	.rf-side-name { flex: 1; min-width: 0; font-size: 13px; font-weight: 600; }

	.rf-panel { background: #fff; border: 1px solid var(--grey-line); border-radius: 12px; padding: 20px 24px; min-width: 0; }
	.rf-panel-head { padding-bottom: 14px; margin-bottom: 18px; border-bottom: 1px solid var(--grey-line); }
	.rf-panel-title { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-size: 18px; font-weight: 700; color: var(--navy); }
	.rf-panel-desc { font-size: 13px; color: var(--grey-text); margin-top: 2px; }
	.rf-slot-label { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: var(--grey-text); }

	.rf-badge.checking { background: #dbeafe; color: #1d4ed8; }
	.rf-panel-file { font-size: 13px; color: var(--navy); margin-top: 4px; }
	.rf-checking {
		border: 1px solid #c9d7ea; background: #f5f8fc; border-radius: 12px; padding: 24px;
		display: flex; flex-direction: column; gap: 14px;
	}
	.rf-checking-title { font-size: 16px; font-weight: 700; color: var(--navy); }
	.rf-step { display: flex; align-items: center; gap: 12px; font-size: 14px; color: var(--grey-text); }
	.rf-step.done, .rf-step.cur { color: var(--navy); }
	.rf-step.cur .rf-step-label { font-weight: 700; }
	.rf-step-dot {
		width: 22px; height: 22px; border-radius: 999px; flex: none; display: flex;
		align-items: center; justify-content: center; background: #b8c0cc; color: #fff;
		font-size: 12px; font-weight: 700;
	}
	.rf-step.done .rf-step-dot { background: #15803d; }
	.rf-step.cur .rf-step-dot { background: #1f4e8c; }
	.rf-bar { height: 6px; border-radius: 3px; background: #dbe4f0; overflow: hidden; }
	.rf-bar-fill { height: 100%; background: #1f4e8c; transition: width .2s ease; }
	.rf-uploaded-view { display: flex; flex-direction: column; gap: 10px; }
	.rf-uploaded-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
	.rf-outline-btn {
		display: inline-flex; align-items: center; gap: 6px; padding: 7px 14px; font-size: 12px;
		font-weight: 600; border-radius: 8px; background: #fff; color: var(--navy);
		border: 1.5px solid var(--grey-line); cursor: pointer; font-family: inherit;
	}
	.rf-outline-btn:hover { border-color: var(--orange); }
	.rf-outline-btn.sm { padding: 5px 10px; border-width: 1px; border-radius: 7px; white-space: nowrap; }
	.rf-file-card {
		position: relative; cursor: pointer;
		display: flex; align-items: center; gap: 12px; padding: 14px 16px;
		border: 1px solid var(--grey-line); border-radius: 10px; background: #fff;
		transition: border-color .15s, box-shadow .15s;
	}
	.rf-file-card:hover { border-color: var(--orange); box-shadow: 0 2px 8px rgba(27, 43, 75, .08); }
	.rf-file-icon { width: 30px; height: 30px; object-fit: contain; flex-shrink: 0; }
	.rf-file-main { flex: 1; min-width: 0; display: block; text-align: left; background: none; border: none; padding: 0; font: inherit; cursor: pointer; }
	.rf-file-name { display: block; font-size: 14px; font-weight: 700; color: var(--navy); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.rf-file-meta { display: block; font-size: 12px; color: var(--grey-text); margin-top: 2px; }
	/* Stretched link: the file-name button's ::after covers the whole card, so a click
	   anywhere opens the preview; the action buttons sit above it. */
	.rf-file-main::after { content: ''; position: absolute; inset: 0; border-radius: 10px; }
	.rf-file-main:focus-visible::after { outline: 2px solid var(--orange); }
	.rf-file-actions { position: relative; z-index: 1; display: flex; align-items: center; gap: 4px; flex-shrink: 0; }
	.rf-trash {
		width: 30px; height: 30px; display: flex; align-items: center; justify-content: center;
		border-radius: 7px; background: #fff; border: 1px solid var(--grey-line);
		color: var(--grey-text); cursor: pointer; padding: 0;
	}
	.rf-trash:hover { color: #b91c1c; border-color: #fca5a5; }

	.rf-picked { list-style: none; margin: 0 0 16px; padding: 0; display: flex; flex-direction: column; gap: 6px; }
	.rf-picked li {
		display: flex; align-items: center; gap: 10px; padding: 8px 12px;
		background: var(--grey-bg); border-radius: 8px; font-size: 13px;
	}
	.rf-picked li.bad { background: var(--red-lt); color: #b91c1c; }
	.rf-picked-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
	.rf-picked-size { font-size: 12px; color: var(--grey-text); flex-shrink: 0; }
	.rf-picked li.bad .rf-picked-size { color: #b91c1c; }

	.rf-info-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 20px; }

	.rf-zone {
		border: 2px dashed var(--grey-line); border-radius: 12px; padding: 40px 24px;
		text-align: center; cursor: pointer; transition: all .2s; margin-bottom: 16px;
		min-height: 280px; display: flex; flex-direction: column; align-items: center; justify-content: center;
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
	.rf-types { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
	.rf-type { background: var(--grey-bg); border-radius: 8px; padding: 9px 6px; text-align: center; }
	.rf-type img { width: 24px; height: 24px; object-fit: contain; display: block; margin: 0 auto 4px; }
	.rf-type span { font-size: 10px; font-weight: 700; color: var(--navy); }

	.rf-guide { background: var(--grey-bg); border-radius: 10px; padding: 14px 16px; font-size: 13px; }
	.rf-guide-hdr { display: flex; align-items: center; gap: 8px; font-weight: 700; margin-bottom: 10px; color: var(--navy); }
	.rf-guide-badge { width: 28px; height: 28px; flex-shrink: 0; background: var(--navy-dark); border-radius: 8px; display: flex; align-items: center; justify-content: center; }
	.rf-guide-badge img { width: 16px; height: 16px; object-fit: contain; }
	.rf-guide-body :global(p) { margin: 0 0 6px; }
	.rf-guide-body :global(ul), .rf-guide :global(ul) { margin: 0; padding-left: 18px; }
	.rf-guide :global(li) { margin-bottom: 4px; }

	.rf-modal-actions { display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--grey-line); padding-top: 16px; }
	.rf-ghost.left { margin-right: auto; }
	.rf-submit {
		min-width: 200px; background: var(--orange); color: #fff; border: none; border-radius: 9px;
		padding: 12px 28px; font-size: 14px; font-weight: 700; cursor: pointer;
	}
	.rf-submit:disabled { opacity: .5; cursor: not-allowed; }
	.rf-ghost { background: #fff; border: 1px solid var(--grey-line); border-radius: 9px; padding: 12px 18px; font-size: 14px; font-weight: 600; color: var(--navy); cursor: pointer; }
</style>
