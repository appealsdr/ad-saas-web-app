<script lang="ts">
	import Topbar from '$components/layout/Topbar.svelte';
	import type { PageData } from './$types';

	export let data: PageData;
</script>

<svelte:head><title>Assistance — Appeals Doctor</title></svelte:head>

<Topbar title="Assistance" subtitle={data.store.name}>
	<a class="btn btn-outline btn-sm" href={`/stores/${data.store.id}`}>← Back to store</a>
</Topbar>

<div class="content-area">
	<div class="card" style="padding:20px">
		<p style="margin:0;font-size:13px;color:var(--grey-text);line-height:1.5">
			Need a hand? Ask a question here and our AI assistant will help, with a human reviewing
			anything before it's acted on.
		</p>
	</div>
</div>

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }
</style>
