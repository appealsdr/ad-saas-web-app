/** Connected AI assistants (OAuth connections to the MCP connector) — AD-1969. Owners/admins see the account's; members see their own. */
import { redirect, error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { listGrants, revokeGrantForAccount, SCOPES } from '$lib/server/oauth/core';
import { mcpAvailable } from '$lib/server/mcp/killswitch';

async function me(userId: string) {
	const [u] = await sql<{ id: string; role: string; account_id: string }[]>`SELECT id, role, account_id FROM users WHERE id = ${userId} AND is_active LIMIT 1`;
	return u ?? null;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');
	const u = await me(locals.user.id);
	if (!u) throw error(404, 'Not found.');
	if (!(await mcpAvailable(u.account_id)).ok) throw error(404, 'Not found.');
	const manager = ['owner', 'admin'].includes(u.role);
	const grants = await listGrants(u.account_id, manager ? null : u.id);
	return {
		manager,
		grants: grants.map((g) => ({
			id: g.id, clientName: g.client_name, userEmail: g.user_email, createdAt: g.created_at.toISOString(),
			lastUsedAt: g.last_used_at?.toISOString() ?? null, revoked: !!g.revoked_at,
			scopes: g.scopes.map((s) => (SCOPES as Record<string, { label: string }>)[s]?.label ?? s)
		}))
	};
};

export const actions: Actions = {
	revoke: async ({ request, locals }) => {
		if (!locals.user) throw redirect(303, '/login');
		const u = await me(locals.user.id);
		if (!u) throw error(404, 'Not found.');
		const id = String((await request.formData()).get('id') ?? '');
		const manager = ['owner', 'admin'].includes(u.role);
		const ok = await revokeGrantForAccount(id, u.account_id, manager ? null : u.id, 'revoked by customer');
		return ok ? { success: 'Disconnected.' } : fail(404, { error: 'Connection not found.' });
	}
};
