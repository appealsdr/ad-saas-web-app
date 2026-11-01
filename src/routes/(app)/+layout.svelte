<script lang="ts">
	import Sidebar from '$components/layout/Sidebar.svelte';
</script>

<!-- Protected app shell: sidebar + scrollable main column -->
<div class="app-shell">
	<Sidebar />
	<div class="main-content">
		<slot />
	</div>
</div>

<style>
	.app-shell {
		display: flex;
		flex-direction: row;
		height: 100vh;
		overflow: hidden;
	}

	.main-content {
		flex: 1;
		display: flex;
		flex-direction: column;
		overflow: hidden;
		height: 100vh;
	}
</style>
