<script lang="ts">
	export let label: string;
	export let value: string | number;
	export let sub = '';
	export let color: 'orange' | 'green' | 'red' | 'navy' = 'navy';
</script>

<div class="stat-card">
	<div class="stat-label">{label}</div>
	<div class="stat-value" style="color: var(--{color})">{value}</div>
	{#if sub}<div class="stat-sub">{sub}</div>{/if}
</div>
