<script lang="ts">
	export let variant: 'green' | 'orange' | 'red' | 'blue' | 'grey' | 'navy' | 'yellow' = 'grey';
</script>

<span class="badge badge-{variant}"><slot /></span>
