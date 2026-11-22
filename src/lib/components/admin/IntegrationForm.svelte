<script lang="ts">
	import { enhance } from '$app/forms';

	export let action = '';
	export let submitLabel = 'Save';
	export let users: { id: string; label: string }[] = [];
	export let permissionOptions: { id: string; label: string }[] = [];
	/** Other integrations on this account that a new integration may copy permissions from (create only). */
	export let copySources: { id: string; name: string }[] = [];
	export let values = {
		name: '', defaultUserId: '', permissions: permissionOptions.map((p) => p.id), allowedIps: '',
		rateLimitPerMinute: 60, credentialTtlDays: '' as number | '', rotationGraceHours: 24
	};
	let copyFrom = '';
	let busy = false;
	$: if (!values.defaultUserId && users[0]) values.defaultUserId = users[0].id;
	$: noneSelected = !copyFrom && values.permissions.length === 0;
</script>

<form method="POST" {action} use:enhance={() => { busy = true; return async ({ update }) => { busy = false; await update({ reset: false }); }; }}>
	<div class="adm-card">
		<h2>Integration</h2>
		<label>Name<br /><input class="adm-input" name="name" bind:value={values.name} maxlength="100" required /></label>
		<p class="adm-muted">Unique within this account (case-insensitive); other accounts may reuse the name.</p>
		<label>Default create/update user<br />
			<select class="adm-input" name="defaultUserId" bind:value={values.defaultUserId} required>
				{#each users as u}<option value={u.id}>{u.label}</option>{/each}
			</select>
		</label>
		<p class="adm-muted">Records created or changed by this integration are attributed to this user.</p>
	</div>

	<div class="adm-card">
		<h2>Permissions</h2>
		{#if copySources.length}
			<label>Copy permissions from another integration<br />
				<select class="adm-input" name="copyPermissionsFromId" bind:value={copyFrom}>
					<option value="">No — use the checkboxes below (all selected by default)</option>
					{#each copySources as c}<option value={c.id}>{c.name}</option>{/each}
				</select>
			</label>
		{/if}
		<fieldset style="border:0;padding:0;margin-top:8px" disabled={!!copyFrom}>
			{#each permissionOptions as p}
				<label style="display:block"><input type="checkbox" name="permissions" value={p.id} bind:group={values.permissions} />
					<code>{p.id}</code> — {p.label}</label>
			{/each}
		</fieldset>
		{#if noneSelected}<div class="adm-alert error">At least one permission must remain selected.</div>{/if}
		<p class="adm-muted">Permissions are explicit and never imply one another. Changes apply on the integration's next request; no credential rotation needed.</p>
	</div>

	<div class="adm-card">
		<h2>Access controls</h2>
		<label>IP allowlist (optional)<br />
			<textarea class="adm-textarea" name="allowedIps" bind:value={values.allowedIps} style="min-height:70px" placeholder="203.0.113.7&#10;198.51.100.0/24"></textarea>
		</label>
		<div class="adm-row" style="margin-top:8px">
			<label>Rate limit (requests/min)<br /><input class="adm-input" type="number" name="rateLimitPerMinute" bind:value={values.rateLimitPerMinute} min="1" max="10000" required /></label>
			<label>New credential lifetime (days, blank = no expiry)<br /><input class="adm-input" type="number" name="credentialTtlDays" bind:value={values.credentialTtlDays} min="1" max="3650" /></label>
			<label>Rotation grace (hours, 0 = revoke old immediately)<br /><input class="adm-input" type="number" name="rotationGraceHours" bind:value={values.rotationGraceHours} min="0" max="720" required /></label>
		</div>
	</div>
	<slot />
	<button class="adm-btn" type="submit" disabled={busy || noneSelected}>{busy ? 'Saving…' : submitLabel}</button>
</form>
