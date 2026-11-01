<script lang="ts">
	import { onDestroy } from 'svelte';

	let message = '';
	let icon = '✓';
	let visible = false;
	let timer: ReturnType<typeof setTimeout>;

	export function show(msg: string, emoji = '✓', duration = 3000) {
		message = msg;
		icon = emoji;
		visible = true;
		clearTimeout(timer);
		timer = setTimeout(() => (visible = false), duration);
	}

	onDestroy(() => clearTimeout(timer));
</script>

<div class="toast" class:show={visible}>
	<span>{icon}</span>
	<span>{message}</span>
</div>
