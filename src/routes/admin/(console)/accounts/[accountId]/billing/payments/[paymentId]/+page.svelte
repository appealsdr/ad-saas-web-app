<script lang="ts">
	import { page } from '$app/stores';
	import RecordDetail from '$lib/components/admin/RecordDetail.svelte';
	import type { PageData } from './$types';
	export let data: PageData;
	$: base = `/admin/accounts/${$page.params.accountId}`;
</script>

<svelte:head><title>Payment {data.name} — Admin</title></svelte:head>
<RecordDetail title={data.name} kindLabel="Payment" recordId={data.key} groups={data.groups}
	sfObject="Payment__c" sfId={data.sfId} sfState={data.sfId ? 'synced' : 'not_in_sf'} sfUrl={data.sfUrl}
	showEdit={false} showDelete={false} backHref="{base}/billing/payments" backLabel="Back to payments">
	<svelte:fragment slot="links">
		{#if data.stripePiUrl}<a class="adm-btn outline" href={data.stripePiUrl} target="_blank" rel="noopener">View in Stripe ↗</a>{/if}
		<a class="adm-btn outline" href="{base}/records/contract/{data.contract.id}">View contract {data.contract.ref}</a>
	</svelte:fragment>
</RecordDetail>
