<script lang="ts">
	export let title = '';
	export let padding = true;
</script>

<div class="card" class:p-0={!padding}>
	{#if title}
		<div class="card-title">{title}<slot name="action" /></div>
	{/if}
	<slot />
</div>

<style>
	.p-0 { padding: 0; }
</style>
