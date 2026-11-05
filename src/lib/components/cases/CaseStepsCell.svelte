<script lang="ts">
	/**
	 * What's still outstanding on a case, shown under the case in a table: onboarding
	 * information not provided and required documents not uploaded. Renders nothing when
	 * there's nothing left to do (or the case is closed).
	 */
	export let steps:
		| { pendingDocs: string[]; onboardingProvided: boolean | null }
		| undefined = undefined;
	export let closed = false;

	$: onboardingPending = steps?.onboardingProvided === false;
	$: docs = steps?.pendingDocs ?? [];
</script>

{#if !closed && steps && (onboardingPending || docs.length > 0)}
	<ul class="todo">
		{#if onboardingPending}
			<li>Onboarding information not provided</li>
		{/if}
		{#each docs as name}
			<li>Not uploaded: {name}</li>
		{/each}
	</ul>
{/if}

<style>
	.todo {
		list-style: none; margin: 4px 0 0; padding: 0;
		display: flex; flex-direction: column; gap: 1px;
		font-size: 11px; font-weight: 500; line-height: 1.35; color: #b45309;
	}
	.todo li::before { content: '• '; }
</style>
