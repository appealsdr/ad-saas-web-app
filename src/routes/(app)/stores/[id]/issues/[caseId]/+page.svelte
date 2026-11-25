<script lang="ts">
	import Topbar from '$components/layout/Topbar.svelte';
	import CaseWorkspace from '$components/cases/CaseWorkspace.svelte';
	import type { PageData, ActionData } from './$types';

	export let data: PageData;
	export let form: ActionData;
</script>

<svelte:head><title>{data.case.CaseNumber} — Appeals Doctor</title></svelte:head>

<Topbar
	title={data.case.CaseNumber}
	subtitle={`${data.case.recordTypeName ?? 'Case'} · ${data.storeName}`}
>
	<a class="btn btn-outline btn-sm" href={`/stores/${data.storeId}`}>← Back to store</a>
</Topbar>

{#key data.case.Id}
	<CaseWorkspace {data} {form} mode="full" />
{/key}

<style>
	.btn-sm {
		padding: 5px 12px; font-size: 12px; font-weight: 600;
		border-radius: 7px; border: 1px solid transparent; cursor: pointer;
	}
</style>
