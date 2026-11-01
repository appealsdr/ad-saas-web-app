<script lang="ts">
	/** Generic result grid: preserves types visually (NULL, JSON, long text, big numbers as strings). */
	export let columns: { name: string; type?: string }[] = [];
	export let rows: Record<string, unknown>[] = [];
	export let caption = 'Results';

	const MAX_CELL = 160;
	function isObj(v: unknown): boolean {
		return v !== null && typeof v === 'object';
	}
	function text(v: unknown): string {
		return isObj(v) ? JSON.stringify(v, null, 2) : String(v);
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="adm-table-wrap" role="region" aria-label={caption} tabindex="0">
	<table class="adm-table">
		<caption class="adm-sr">{caption}</caption>
		<thead>
			<tr>
				{#each columns as c}<th scope="col">{c.name}{#if c.type}<br /><span class="adm-muted" style="text-transform:none;font-weight:400">{c.type}</span>{/if}</th>{/each}
			</tr>
		</thead>
		<tbody>
			{#each rows as row}
				<tr>
					{#each columns as c}
						{@const v = row[c.name]}
						<td class={typeof v === 'number' || /^(bigint|integer|numeric|smallint)$/.test(c.type ?? '') ? 'adm-mono' : ''}>
							{#if v === null || v === undefined}
								<span class="adm-null">NULL</span>
							{:else if isObj(v) || text(v).length > MAX_CELL}
								<details>
									<summary class="adm-mono">{text(v).replace(/\s+/g, ' ').slice(0, 60)}…</summary>
									<pre class="adm-pre">{text(v)}</pre>
								</details>
							{:else if typeof v === 'boolean'}{v ? 'true' : 'false'}
							{:else}{String(v)}{/if}
						</td>
					{/each}
				</tr>
			{/each}
		</tbody>
	</table>
</div>
