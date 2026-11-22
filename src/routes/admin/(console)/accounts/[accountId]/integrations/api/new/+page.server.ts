import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { listAccountUsers } from '$lib/server/admin/accounts';
import { auditActor, clientIp } from '$lib/server/admin/guard';
import { ActionError } from '$lib/server/admin/actions';
import { createIntegration, listIntegrations } from '$lib/server/integrations/service';
import { PERMISSION_OPTIONS, parseIntegrationForm } from '$lib/server/integrations/form';

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'accounts.update');
	const [users, integrations] = await Promise.all([listAccountUsers(accountId), listIntegrations(accountId)]);
	return {
		users: users.filter((u) => u.is_active).map((u) => ({ id: u.id, label: `${u.display_name || u.email} (${u.email})` })),
		copySources: integrations.map((i) => ({ id: i.id, name: i.name, permissions: i.permissions })),
		permissionOptions: PERMISSION_OPTIONS
	};
};

export const actions: Actions = {
	default: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update', { freshMfa: true });
		const input = parseIntegrationForm(await event.request.formData());
		try {
			const r = await createIntegration({ actor: auditActor(staff), ip: clientIp(event) }, accountId, input);
			// The raw secret is returned exactly once, in this response only.
			return { created: { id: r.id, name: input.name.trim(), rawKey: r.rawKey } };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message });
			throw e;
		}
	}
};
