<script lang="ts">
	export let variant: 'primary' | 'outline' | 'ghost' | 'danger' = 'primary';
	export let size: 'sm' | 'base' | 'lg' = 'base';
	export let full = false;
	export let disabled = false;
	export let type: 'button' | 'submit' | 'reset' = 'button';

	$: cls = [
		'btn',
		`btn-${variant}`,
		size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '',
		full ? 'btn-full' : ''
	]
		.filter(Boolean)
		.join(' ');
</script>

<button {type} class={cls} {disabled} on:click><slot /></button>
