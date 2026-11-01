<script lang="ts">
	import type { PageData } from './$types';
	export let data: PageData;

	function fmtDateTime(iso: string | null | undefined) {
		if (!iso) return '—';
		try {
			const d = new Date(iso);
			return (
				d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
				' at ' +
				d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase()
			);
		} catch {
			return iso;
		}
	}

	function fmtRelativeTtl(iso: string | null | undefined) {
		if (!iso) return null;
		const ms = new Date(iso).getTime() - Date.now();
		if (!Number.isFinite(ms) || ms <= 0) return null;
		const m = Math.round(ms / 60000);
		if (m < 60) return `${m} min`;
		const h = Math.round(m / 60);
		return `${h}h`;
	}
</script>

<svelte:head><title>Connected to Amazon — {data.store.name}</title></svelte:head>

<div class="wrap">
	<div class="card">
		<div class="amazon-strip">
			<svg class="logo-mark" viewBox="0 0 24 24" aria-hidden="true">
				<path
					fill="#FF9900"
					d="M19.43 17.42c-3.13 2.31-7.66 3.54-11.56 3.54-5.46 0-10.39-2.02-14.11-5.38-.3-.27-.03-.63.32-.43 4.04 2.36 9.05 3.79 14.23 3.79 3.54 0 7.42-.74 11-2.25.54-.23.99.36.46.73z"
				/>
				<path fill="#FF9900" d="M20.7 16.05c-.4-.51-2.62-.24-3.62-.12-.31.04-.35-.23-.08-.43 1.78-1.25 4.69-.89 5.03-.47.34.42-.09 3.34-1.75 4.73-.26.21-.5.1-.39-.18.39-.93 1.21-3.02.81-3.53z"/>
				<text x="2" y="9" font-family="Helvetica, Arial, sans-serif" font-size="9" font-weight="800" fill="#232F3E">amazon</text>
			</svg>
			<span class="dot-row"><span class="dot" /><span class="dot" /><span class="dot" /></span>
			<span class="brand-tag">Appeals Doctor</span>
		</div>

		<div class="check">
			<div class="check-circle">✓</div>
		</div>

		<h1>You're connected to Amazon</h1>
		<p class="lede">
			<strong>{data.store.name}</strong> is now linked to Selling Partner API. We'll start
			monitoring this store and surface violations as they appear.
		</p>

		<dl class="kv">
			<dt>Store</dt>
			<dd>{data.store.name}</dd>

			{#if data.store.marketplaces}
				<dt>Marketplaces</dt>
				<dd>{data.store.marketplaces.split(';').join(', ')}</dd>
			{/if}

			{#if data.store.country}
				<dt>Country</dt>
				<dd>{data.store.country}</dd>
			{/if}

			<dt>Selling Partner ID</dt>
			<dd class="mono">{data.store.spapiConnectedSellerId ?? data.store.sellerId ?? '—'}</dd>

			<dt>Connected at</dt>
			<dd>{fmtDateTime(data.store.spapiConnectedAt)}</dd>

			{#if data.store.spapiAccessTokenExpiresAt}
				<dt>Access token valid for</dt>
				<dd>{fmtRelativeTtl(data.store.spapiAccessTokenExpiresAt) ?? '—'} (auto-refreshed)</dd>
			{/if}

			{#if data.store.sfdcStoreId}
				<dt>Salesforce Store</dt>
				<dd class="mono">{data.store.sfdcStoreId}</dd>
			{/if}
		</dl>

		<div class="enables">
			<div class="enables-title">What this enables</div>
			<ul>
				<li>📦 Pull live order &amp; listing data from Amazon</li>
				<li>🚨 Receive violation &amp; performance notifications</li>
				<li>📄 Auto-attach evidence to appeals as it changes</li>
				<li>🔄 Background access-token refresh (no re-auth needed)</li>
			</ul>
		</div>

		{#if Object.keys(data.store.spapiCallbackParams).length > 0}
			<details class="raw-params">
				<summary>Raw Amazon callback parameters</summary>
				<div class="raw-list">
					{#each Object.entries(data.store.spapiCallbackParams) as [k, v]}
						<div class="raw-row">
							<span class="raw-k">{k}</span>
							<code class="raw-v">{v}</code>
						</div>
					{/each}
				</div>
				<p class="raw-note">
					These are the URL parameters Amazon sent on the redirect back. The one-time
					<code>spapi_oauth_code</code> is intentionally not persisted.
				</p>
			</details>
		{/if}

		<div class="actions">
			<a class="btn-primary" href={`/stores/${data.store.id}`}>
				Continue to {data.store.name} →
			</a>
			<a class="btn-secondary" href="/stores">All stores</a>
		</div>

		<p class="small">
			You can reconnect or disconnect anytime from the store page.
		</p>
	</div>
</div>

<style>
	.wrap {
		min-height: 100vh; display: grid; place-items: center;
		padding: 32px 20px;
		background: linear-gradient(180deg, #faf7f2 0%, #f3eee6 100%);
	}
	.card {
		background: white; border-radius: 20px;
		padding: 32px 36px;
		width: 100%; max-width: 560px;
		box-shadow: 0 20px 60px rgba(0,0,0,.08);
		text-align: center;
	}

	/* Amazon strip — subtle brand cue */
	.amazon-strip {
		display: flex; align-items: center; justify-content: center;
		gap: 12px; padding-bottom: 18px;
		border-bottom: 1px solid #f1eadc;
		margin-bottom: 22px;
		color: #232F3E;
	}
	.logo-mark { width: 64px; height: 26px; }
	.dot-row { display: inline-flex; gap: 4px; }
	.dot {
		width: 4px; height: 4px; border-radius: 50%; background: #d6cab5;
	}
	.brand-tag { font-size: 13px; font-weight: 700; color: var(--navy); }

	.check { margin-bottom: 14px; }
	.check-circle {
		width: 72px; height: 72px; border-radius: 50%;
		background: #d1fae5; color: #047857;
		display: inline-flex; align-items: center; justify-content: center;
		font-size: 38px; font-weight: 900;
		box-shadow: 0 0 0 6px #ecfdf5;
		margin: 0 auto;
	}

	h1 {
		font-size: 24px; font-weight: 800; color: var(--navy);
		margin: 0 0 8px;
	}
	.lede {
		font-size: 14px; color: var(--grey-text); line-height: 1.5;
		margin: 0 auto 22px;
		max-width: 420px;
	}

	/* Key/value table */
	dl.kv {
		display: grid; grid-template-columns: max-content 1fr;
		gap: 8px 16px; text-align: left;
		margin: 0 0 22px;
		padding: 16px 18px;
		background: #fafafa; border: 1px solid var(--grey-line);
		border-radius: 12px;
	}
	dl.kv dt {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .04em; color: var(--grey-text);
		align-self: center;
	}
	dl.kv dd {
		margin: 0; font-size: 13px; font-weight: 500; color: var(--navy);
		word-break: break-word;
	}
	dl.kv dd.mono {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px;
	}

	.enables {
		text-align: left;
		background: #fff7eb; border: 1px solid #f6d49b;
		border-radius: 12px; padding: 14px 18px;
		margin-bottom: 22px;
	}
	.enables-title {
		font-size: 11px; font-weight: 700; text-transform: uppercase;
		letter-spacing: .05em; color: #8a6500; margin-bottom: 8px;
	}
	.enables ul {
		list-style: none; padding: 0; margin: 0;
		display: grid; gap: 6px; font-size: 13px; color: var(--navy);
	}

	.actions {
		display: flex; gap: 10px; justify-content: center; flex-wrap: wrap;
		margin-bottom: 12px;
	}
	.btn-primary {
		background: #FF9900; color: white; text-decoration: none;
		font-weight: 700; font-size: 14px;
		padding: 12px 22px; border-radius: 10px;
		transition: background .2s, transform .15s;
	}
	.btn-primary:hover { background: #e68a00; transform: translateY(-1px); }
	.btn-secondary {
		background: white; color: var(--navy); text-decoration: none;
		font-weight: 700; font-size: 14px;
		padding: 12px 22px; border-radius: 10px;
		border: 1.5px solid var(--grey-line);
	}
	.btn-secondary:hover { background: #fafafa; }

	.small { font-size: 11px; color: var(--grey-text); margin: 0; }

	/* Collapsible raw params */
	.raw-params {
		text-align: left; margin-top: 18px;
		background: #fafafa; border: 1px solid var(--grey-line);
		border-radius: 12px; padding: 0;
	}
	.raw-params summary {
		cursor: pointer; padding: 10px 14px; font-size: 12px; font-weight: 700;
		color: var(--grey-text); text-transform: uppercase; letter-spacing: .05em;
		list-style: revert;
	}
	.raw-params summary::marker { color: var(--grey-text); }
	.raw-list { padding: 0 14px 8px; display: grid; gap: 6px; }
	.raw-row {
		display: grid; grid-template-columns: max-content 1fr; gap: 12px;
		align-items: center; font-size: 12px;
	}
	.raw-k {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: var(--grey-text);
	}
	.raw-v {
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		background: white; padding: 2px 6px; border-radius: 4px;
		border: 1px solid var(--grey-line);
		color: var(--navy); word-break: break-all;
	}
	.raw-note {
		font-size: 11px; color: var(--grey-text);
		padding: 0 14px 14px; margin: 0;
	}
	.raw-note code {
		font-family: ui-monospace, monospace; background: white;
		padding: 1px 5px; border-radius: 3px; border: 1px solid var(--grey-line);
	}
</style>
