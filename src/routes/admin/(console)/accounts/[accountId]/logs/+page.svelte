<script lang="ts">
	import LogView from '$lib/components/admin/LogView.svelte';
	import { page } from '$app/stores';
	import type { PageData } from './$types';
	export let data: PageData;
</script>

<svelte:head><title>Account logs — Admin</title></svelte:head>
<div class="adm-alert info">Only records that were written <strong>with this account’s ID</strong> appear here. Older records have no account attribution and are available, labelled “unattributed”, in the global <a href="/admin/logs?account=unattributed">Logs</a> view — they are never guessed onto an account.</div>
<LogView entries={data.entries} nextCursor={data.nextCursor} filters={data.filters} action="/admin/accounts/{$page.params.accountId}/logs" showAccountFilter={false} />
