/**
 * /oauth/authorize — sign-in + consent for the AI connector (AD-1969).
 * Uses the normal customer session (login, MFA if any). Only account owners/admins can connect an assistant.
 * Invalid client / redirect_uri → an error page (never a redirect). Everything is re-validated on POST.
 */
import { redirect, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import { loginUrlPreserving } from '$lib/server/auth/redirects';
import { getClient, parseScopes, validChallenge, createGrant, createAuthCode, SCOPES, ALL_SCOPES, type OAuthClient, type Scope } from '$lib/server/oauth/core';
import { publicOrigin } from '$lib/server/oauth/meta';
import { mcpAvailable } from '$lib/server/mcp/killswitch';

interface Params { client: OAuthClient; redirectUri: string; codeChallenge: string; scopes: Scope[]; state: string | null; resource: string | null }
type Parsed = { ok: true; p: Params } | { ok: false; message: string };

async function parse(get: (k: string) => string | null, origin: string): Promise<Parsed> {
	const client = await getClient(get('client_id') ?? '');
	if (!client) return { ok: false, message: 'Unknown application.' };
	const redirectUri = get('redirect_uri') ?? '';
	if (!client.redirect_uris.includes(redirectUri)) return { ok: false, message: 'The application used an unregistered return address.' };
	if (get('response_type') !== 'code') return { ok: false, message: 'Unsupported response type.' };
	const codeChallenge = get('code_challenge') ?? '';
	if (get('code_challenge_method') !== 'S256' || !validChallenge(codeChallenge)) return { ok: false, message: 'The application did not use PKCE (S256).' };
	const resource = get('resource');
	if (resource && resource !== `${origin}/mcp`) return { ok: false, message: 'Unknown resource.' };
	return { ok: true, p: { client, redirectUri, codeChallenge, scopes: parseScopes(get('scope')), state: get('state'), resource } };
}

async function currentUser(userId: string) {
	const [u] = await sql<{ id: string; email: string; role: string; account_id: string; account_name: string }[]>`
		SELECT u.id, u.email, u.role, u.account_id, a.name AS account_name FROM users u JOIN accounts a ON a.id = u.account_id
		WHERE u.id = ${userId} AND u.is_active LIMIT 1`;
	return u ?? null;
}

const back = (uri: string, params: Record<string, string>) => {
	const u = new URL(uri);
	for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
	return u.toString();
};

export const load: PageServerLoad = async ({ url, locals }) => {
	const origin = publicOrigin(url.origin);
	const parsed = await parse((k) => url.searchParams.get(k), origin);
	if (!parsed.ok) return { error: parsed.message };
	if (!locals.user) throw redirect(303, loginUrlPreserving(url.pathname + url.search));
	if (locals.readOnly) return { error: 'This is a read-only support session; connecting an assistant is not available.' };
	const user = await currentUser(locals.user.id);
	if (!user) return { error: 'Your account could not be found.' };
	if (!['owner', 'admin'].includes(user.role)) return { error: 'Only account owners and admins can connect an AI assistant.' };
	if (!(await mcpAvailable(user.account_id)).ok) return { error: 'The AI assistant connection is not enabled for your account yet. Please contact support.' };
	const p = parsed.p;
	return {
		error: null,
		clientName: p.client.client_name,
		accountName: user.account_name,
		email: user.email,
		scopes: ALL_SCOPES.map((s) => ({ id: s, label: SCOPES[s].label, required: s === 'read', checked: p.scopes.includes(s) }))
	};
};

export const actions: Actions = {
	default: async ({ request, url, locals }) => {
		const origin = publicOrigin(url.origin);
		const form = await request.formData();
		const get = (k: string) => (form.has(k) ? String(form.get(k)) : null);
		const parsed = await parse(get, origin);
		if (!parsed.ok) return fail(400, { error: parsed.message });
		if (!locals.user || locals.readOnly) throw redirect(303, loginUrlPreserving(url.pathname));
		const p = parsed.p;
		const finish = (extra: Record<string, string>) => {
			throw redirect(303, back(p.redirectUri, { ...extra, ...(p.state ? { state: p.state } : {}), iss: origin }));
		};
		if (get('decision') !== 'approve') return finish({ error: 'access_denied' });

		const user = await currentUser(locals.user.id);
		if (!user || !['owner', 'admin'].includes(user.role)) return fail(403, { error: 'Only account owners and admins can connect an AI assistant.' });
		if (!(await mcpAvailable(user.account_id)).ok) return fail(403, { error: 'The AI assistant connection is not enabled for your account.' });

		// Scopes come from the checkboxes (read is always on); never trust more than the app offered.
		const picked = new Set<Scope>(['read', ...(form.getAll('scope').map(String).filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s)))]);
		const scopes = ALL_SCOPES.filter((s) => picked.has(s) && (s === 'read' || p.scopes.includes(s)));
		const grantId = await createGrant({ client: p.client, userId: user.id, accountId: user.account_id, scopes });
		const code = await createAuthCode({ grantId, redirectUri: p.redirectUri, codeChallenge: p.codeChallenge, resource: p.resource });
		return finish({ code });
	}
};
