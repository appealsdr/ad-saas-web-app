<script lang="ts">
	import { enhance } from '$app/forms';

	export let action = '';
	export let submitLabel = 'Save';
	export let users: { id: string; label: string }[] = [];
	export let permissionOptions: { id: string; label: string }[] = [];
	/** Other integrations on this account a new integration may start from (create only). */
	export let copySources: { id: string; name: string; permissions: string[] }[] = [];
	export let values = {
		name: '', description: '', defaultUserId: '', permissions: permissionOptions.map((p) => p.id), allowedIps: '',
		rateLimitPerMinute: 60, credentialTtlDays: '' as number | '', rotationGraceHours: 24
	};

	const GROUPS: [string, string, string][] = [
		['stores', 'Stores', 'Create and manage the account’s stores'],
		['cases', 'Cases', 'Open and read cases for a store'],
		['messages', 'Messages', 'Read and write case comments'],
		['files', 'Files', 'Required-file instructions and uploads']
	];
	$: groups = GROUPS.map(([key, title, hint]) => ({ key, title, hint, items: permissionOptions.filter((p) => p.id.startsWith(key + '.')) }));

	let copyFrom = '';
	let busy = false;
	$: if (!values.defaultUserId && users[0]) values.defaultUserId = users[0].id;
	$: noneSelected = values.permissions.length === 0;
	const all = () => (values.permissions = permissionOptions.map((p) => p.id));
	const none = () => (values.permissions = []);
	function onCopyChange() {
		const src = copySources.find((c) => c.id === copyFrom);
		values.permissions = src ? permissionOptions.map((p) => p.id).filter((id) => src.permissions.includes(id)) : permissionOptions.map((p) => p.id);
	}
	const toggleGroup = (items: { id: string }[], on: boolean) => {
		const ids = items.map((i) => i.id);
		values.permissions = on ? [...new Set([...values.permissions, ...ids])] : values.permissions.filter((p) => !ids.includes(p));
	};
</script>

<form class="ifm" method="POST" {action} use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update({ reset: false }); }; }}>
	<section class="adm-card">
		<h2>Details</h2>
		<div class="field">
			<label for="if-name">Integration name <span class="req">*</span></label>
			<input id="if-name" class="adm-input" name="name" bind:value={values.name} maxlength="100" required placeholder="e.g. Customer ERP" />
			<p class="hint">Shown in the admin list and audit log. Must be unique within this account.</p>
		</div>
		<div class="field">
			<label for="if-desc">Description</label>
			<textarea id="if-desc" class="adm-input" name="description" bind:value={values.description} maxlength="500" rows="2" placeholder="What is this integration used for, and who owns it?"></textarea>
			<p class="hint">{values.description.length}/500 · Optional, for your team only.</p>
		</div>
		<div class="field">
			<label for="if-user">Default user <span class="req">*</span></label>
			<select id="if-user" class="adm-input" name="defaultUserId" bind:value={values.defaultUserId} required>
				{#each users as u}<option value={u.id}>{u.label}</option>{/each}
			</select>
			<p class="hint">Stores, cases and messages created or changed through this integration are attributed to this user.</p>
		</div>
	</section>

	<section class="adm-card">
		<div class="head">
			<div>
				<h2>Permissions</h2>
				<p class="hint" style="margin:0">Choose exactly what this integration may do. <strong>{values.permissions.length} of {permissionOptions.length}</strong> selected. Permissions are independent — none implies another. <a href="/admin/api-integrations#perms" target="_blank" rel="noopener">What does each one return?</a></p>
			</div>
			<div class="quick"><button type="button" class="adm-btn outline sm" on:click={all}>Select all</button><button type="button" class="adm-btn outline sm" on:click={none}>Clear</button></div>
		</div>
		{#if copySources.length}
			<div class="field" style="margin-top:12px">
				<label for="if-copy">Start from another integration (optional)</label>
				<select id="if-copy" class="adm-input" name="copyPermissionsFromId" bind:value={copyFrom} on:change={onCopyChange}>
					<option value="">None — start with all permissions ticked</option>
					{#each copySources as c}<option value={c.id}>{c.name} ({c.permissions.length} permissions)</option>{/each}
				</select>
				<p class="hint">Pre-fills the boxes below with that integration’s permissions. You can still change any of them.</p>
			</div>
		{/if}
		<div class="groups">
			{#each groups as g}
				<fieldset>
					<legend>{g.title}</legend>
					<p class="hint">{g.hint}</p>
					{#each g.items as p}
						<label class="perm"><input type="checkbox" name="permissions" value={p.id} bind:group={values.permissions} />
							<span>{p.label}<code>{p.id}</code></span></label>
					{/each}
					<div class="gq"><button type="button" class="lnk" on:click={() => toggleGroup(g.items, true)}>all</button> · <button type="button" class="lnk" on:click={() => toggleGroup(g.items, false)}>none</button></div>
				</fieldset>
			{/each}
		</div>
		{#if noneSelected}<div class="adm-alert error">Select at least one permission.</div>{/if}
		<p class="hint">Changes apply on the integration’s next request — no credential rotation needed.</p>
	</section>

	<section class="adm-card">
		<h2>Access &amp; credentials</h2>
		<div class="field">
			<label for="if-ip">Allowed IP addresses</label>
			<textarea id="if-ip" class="adm-input mono" name="allowedIps" bind:value={values.allowedIps} rows="2" placeholder="203.0.113.7&#10;198.51.100.0/24"></textarea>
			<p class="hint">One address or CIDR range per line. Leave empty to allow any IP.</p>
		</div>
		<div class="grid3">
			<div class="field">
				<label for="if-rate">Rate limit (requests / minute)</label>
				<input id="if-rate" class="adm-input" type="number" name="rateLimitPerMinute" bind:value={values.rateLimitPerMinute} min="1" max="10000" required />
				<p class="hint">Applies to this integration only.</p>
			</div>
			<div class="field">
				<label for="if-ttl">Credential lifetime (days)</label>
				<input id="if-ttl" class="adm-input" type="number" name="credentialTtlDays" bind:value={values.credentialTtlDays} min="1" max="3650" placeholder="No expiry" />
				<p class="hint">Applied to newly issued credentials.</p>
			</div>
			<div class="field">
				<label for="if-grace">Rotation grace period (hours)</label>
				<input id="if-grace" class="adm-input" type="number" name="rotationGraceHours" bind:value={values.rotationGraceHours} min="0" max="720" required />
				<p class="hint">How long old credentials keep working after a rotation. 0 = revoke immediately.</p>
			</div>
		</div>
	</section>
	<slot />
	<div class="actions"><button class="adm-btn" type="submit" disabled={busy || noneSelected}>{busy ? 'Saving…' : submitLabel}</button></div>
</form>

<style>
	.ifm { font-size: 13px; max-width: 920px; }
	.ifm :global(.adm-card h2) { font-size: 15px; font-weight: 800; }
	.field { margin-bottom: 14px; }
	.field label { display: block; font-size: 12px; font-weight: 700; margin-bottom: 5px; }
	.req { color: var(--red, #b91c1c); }
	.field :global(.adm-input) { width: 100%; max-width: 480px; box-sizing: border-box; }
	textarea.adm-input { font-family: inherit; resize: vertical; min-height: 0; }
	textarea.adm-input.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
	.hint { color: var(--grey-text); font-size: 12px; margin: 5px 0 0; line-height: 1.4; }
	.head { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; flex-wrap: wrap; }
	.quick { display: flex; gap: 8px; }
	.groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; margin: 14px 0 8px; }
	fieldset { border: 1px solid var(--grey-line); border-radius: 10px; padding: 10px 14px 12px; margin: 0; min-width: 0; }
	legend { font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .4px; padding: 0 6px; }
	fieldset .hint { margin: 0 0 8px; }
	.perm { display: flex; gap: 8px; align-items: flex-start; padding: 5px 0; cursor: pointer; font-size: 13px; }
	.perm input { margin-top: 2px; accent-color: var(--orange, #f5a100); }
	.perm span { display: flex; flex-direction: column; gap: 1px; }
	.perm code { font-size: 11px; color: var(--grey-text); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
	.gq { font-size: 12px; color: var(--grey-text); margin-top: 6px; }
	.lnk { background: none; border: 0; padding: 0; color: var(--navy); font-weight: 600; cursor: pointer; font-size: 12px; text-decoration: underline; }
	.grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; }
	.grid3 .field :global(.adm-input) { max-width: 100%; }
	.actions { margin-top: 4px; }
</style>
