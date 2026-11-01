<script lang="ts">
	import { page } from '$app/stores';
	import RecordDetail from '$lib/components/admin/RecordDetail.svelte';
	import type { PageData } from './$types';
	export let data: PageData;
</script>

<svelte:head><title>Case {data.number} — Admin</title></svelte:head>
<RecordDetail title={`Case ${data.number}`} kindLabel="Case" recordId={data.id} groups={data.groups}
	sfObject="Case" sfId={data.id} sfState="synced" sfUrl={data.sfUrl} showEdit={false} showDelete={false}
	backHref="/admin/accounts/{$page.params.accountId}/cases" backLabel="Back to cases">
	{#if data.store}<p class="adm-muted">Store: <a href="/admin/accounts/{$page.params.accountId}/records/store/{data.store.id}">{data.store.name}</a></p>{/if}
</RecordDetail>
