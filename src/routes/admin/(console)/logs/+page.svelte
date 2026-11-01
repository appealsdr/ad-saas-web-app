<script lang="ts">
	import LogView from '$lib/components/admin/LogView.svelte';
	import type { PageData } from './$types';
	export let data: PageData;
</script>

<svelte:head><title>Logs — Admin</title></svelte:head>
<h1 class="adm-h1">Stored application logs</h1>
<p class="adm-sub">Error log, activity log and admin audit records retained in the database. Secrets are redacted. Rows without an account are explicitly unattributed.</p>
<LogView entries={data.entries} nextCursor={data.nextCursor} filters={data.filters} action="/admin/logs" />
