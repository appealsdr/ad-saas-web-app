<script lang="ts">
	/**
	 * Lightweight rich-text editor (contenteditable + formatting toolbar).
	 * Two-way binds `value` as HTML. Output is sanitized server-side on submit,
	 * so this only needs to produce reasonable HTML.
	 */
	import { onMount, createEventDispatcher } from 'svelte';

	export let value = '';
	export let placeholder = 'Write a message…';
	/** When true, plain Enter fires the `submit` event instead of a newline (Shift+Enter still inserts one). */
	export let submitOnEnter = false;

	const dispatch = createEventDispatcher<{ submit: void }>();

	let editor: HTMLDivElement;

	onMount(() => {
		if (value) editor.innerHTML = value;
	});

	function sync() {
		value = editor.innerHTML;
	}

	function exec(command: string, arg?: string) {
		editor.focus();
		document.execCommand(command, false, arg);
		sync();
	}

	function addLink() {
		const url = prompt('Link URL (https://…):');
		if (url) exec('createLink', url);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			dispatch('submit');
		}
	}

	// Clear the editor when the bound value is reset externally (e.g. after send).
	$: if (editor && value === '' && editor.innerHTML !== '') editor.innerHTML = '';
</script>

<div class="rte">
	<div class="rte-toolbar">
		<button type="button" title="Bold" on:click={() => exec('bold')}><b>B</b></button>
		<button type="button" title="Italic" on:click={() => exec('italic')}><i>I</i></button>
		<button type="button" title="Underline" on:click={() => exec('underline')}><u>U</u></button>
		<span class="rte-sep"></span>
		<button type="button" title="Bulleted list" on:click={() => exec('insertUnorderedList')}>• List</button>
		<button type="button" title="Numbered list" on:click={() => exec('insertOrderedList')}>1. List</button>
		<button type="button" title="Add link" on:click={addLink}>🔗</button>
		<button type="button" title="Clear formatting" on:click={() => exec('removeFormat')}>✕</button>
	</div>
	<div
		class="rte-editor"
		contenteditable="true"
		bind:this={editor}
		on:input={sync}
		on:keydown={handleKeydown}
		data-placeholder={placeholder}
		role="textbox"
		aria-multiline="true"
		tabindex="0"
	></div>
</div>

<style>
	.rte {
		border: 1.5px solid var(--grey-line);
		border-radius: 9px;
		overflow: hidden;
		transition: border-color 0.2s;
	}
	.rte:focus-within {
		border-color: var(--orange);
	}
	.rte-toolbar {
		display: flex;
		align-items: center;
		gap: 2px;
		padding: 5px 6px;
		border-bottom: 1px solid var(--grey-line);
		background: var(--grey-bg);
		flex-wrap: wrap;
	}
	.rte-toolbar button {
		background: none;
		border: none;
		border-radius: 6px;
		padding: 4px 8px;
		font-size: 12px;
		color: var(--navy);
		cursor: pointer;
		line-height: 1;
		transition: background 0.15s;
	}
	.rte-toolbar button:hover {
		background: var(--grey-line);
	}
	.rte-sep {
		width: 1px;
		height: 16px;
		background: var(--grey-line);
		margin: 0 4px;
	}
	.rte-editor {
		min-height: 64px;
		max-height: 180px;
		overflow-y: auto;
		padding: 10px 13px;
		font-size: 13px;
		line-height: 1.45;
		color: var(--navy-dark);
		outline: none;
	}
	.rte-editor:empty::before {
		content: attr(data-placeholder);
		color: var(--grey-text);
	}
	.rte-editor :global(ul),
	.rte-editor :global(ol) {
		margin: 4px 0;
		padding-left: 22px;
	}
	.rte-editor :global(a) {
		color: var(--orange-dk);
		text-decoration: underline;
	}
</style>
