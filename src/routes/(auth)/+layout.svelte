<script lang="ts">
	// Auth routes use a full-screen centered layout — no sidebar
</script>

<div class="auth-bg">
	<slot />
</div>

<style>
	.auth-bg {
		min-height: 100vh;
		background: linear-gradient(135deg, var(--navy-dark) 0%, var(--navy-soft) 100%);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		padding: 24px;
	}
</style>
