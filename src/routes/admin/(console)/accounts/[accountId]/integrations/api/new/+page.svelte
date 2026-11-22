<script lang="ts">
	import { page } from '$app/stores';
	import IntegrationForm from '$lib/components/admin/IntegrationForm.svelte';
	import type { ActionData, PageData } from './$types';
	export let data: PageData;
	export let form: ActionData;
	$: base = `/admin/accounts/${$page.params.accountId}/integrations`;
	$: created = form && 'created' in form ? form.created : null;
	$: error = form && 'error' in form ? form.error : null;
</script>

<svelte:head><title>Add API integration — Admin</title></svelte:head>
<p><a href={base}>← Integrations</a></p>
<h1 class="adm-h1">Add API integration</h1>

{#if created}
	<div class="adm-card">
		<h2>{created.name} created</h2>
		{#if created.rawKey}
			<div class="adm-alert">Copy this credential now — it is shown once and cannot be retrieved again.</div>
			<pre class="adm-pre adm-mono" data-testid="raw-key">{created.rawKey}</pre>
		{/if}
		<p><a class="adm-btn" href="{base}/api/{created.id}">Open integration</a> <a href={base}>Back to list</a></p>
	</div>
{:else}
	{#if error}<div class="adm-alert error">{error}</div>{/if}
	<IntegrationForm submitLabel="Create integration" users={data.users} permissionOptions={data.permissionOptions} copySources={data.copySources} />
{/if}
