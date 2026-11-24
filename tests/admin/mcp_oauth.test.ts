import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeUser } from '../setup/db';

const d = describe.skipIf(!hasDb);

d('MCP OAuth, kill switches and alerts', async () => {
	const core = await import('$lib/server/oauth/core');
	const { requireIntegrationPermission } = await import('$lib/server/integrations/auth');
	const { mcpAvailable, setGlobalMcpEnabled } = await import('$lib/server/mcp/killswitch');
	const { raiseAlert, listAlerts, acknowledgeAlert } = await import('$lib/server/security/alerts');
	const { ApiError } = await import('$lib/server/integrations/errors');

	const verifier = () => randomBytes(40).toString('base64url');
	const challenge = (v: string) => createHash('sha256').update(v).digest('base64url');
	const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
	const bearer = (t: string) => new Request('http://x/mcp', { headers: { authorization: `Bearer ${t}` } });
	const codeOf = async (p: Promise<unknown>) => { try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : e instanceof core.OAuthError ? e.code : `other:${(e as Error).message}`; } };

	async function setup(enable = true) {
		const acct = await makeAccount();
		const owner = await makeUser({ accountId: acct.id, role: 'owner' });
		if (enable) await sql`UPDATE accounts SET mcp_enabled = true WHERE id = ${acct.id}`;
		await setGlobalMcpEnabled(true, 'test');
		const client = await core.registerClient('Claude', [REDIRECT]);
		return { acct, owner, client };
	}
	async function connect(s: Awaited<ReturnType<typeof setup>>, scopes: ('read' | 'messages:write' | 'files:write')[] = ['read']) {
		const v = verifier();
		const grantId = await core.createGrant({ client: s.client, userId: s.owner.id, accountId: s.acct.id, scopes });
		const code = await core.createAuthCode({ grantId, redirectUri: REDIRECT, codeChallenge: challenge(v), resource: null });
		return { v, grantId, code };
	}
	const exchange = (s: Awaited<ReturnType<typeof setup>>, c: { v: string; code: string }, over: Record<string, string> = {}) =>
		core.exchangeCode({ code: c.code, clientId: s.client.client_id, redirectUri: REDIRECT, verifier: c.v, resource: null, ...over });

	it('registers only safe clients', async () => {
		await expect(core.registerClient('x', ['http://evil.example/cb'])).rejects.toMatchObject({ code: 'invalid_redirect_uri' });
		await expect(core.registerClient('x', [])).rejects.toMatchObject({ code: 'invalid_redirect_uri' });
		expect((await core.getClient('adc_does-not-exist-000000000'))).toBeNull();
	});

	it('authorization code + PKCE gives a working, narrowly-scoped access token that only /mcp accepts', async () => {
		const s = await setup();
		const c = await connect(s, ['read', 'messages:write']);
		const t = await exchange(s, c);
		expect(t).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'read messages:write' });

		const p = await requireIntegrationPermission(bearer(t.access_token), 'cases.read', { allowOAuth: true });
		expect(p).toMatchObject({ accountId: s.acct.id, defaultUserId: s.owner.id });
		expect(p.permissions).toContain('messages.create');
		expect(p.permissions).not.toContain('files.upload');
		expect(await codeOf(requireIntegrationPermission(bearer(t.access_token), 'files.upload', { allowOAuth: true }))).toBe('PERMISSION_DENIED');
		// Audience binding: the same token is useless on the REST API.
		expect(await codeOf(requireIntegrationPermission(bearer(t.access_token), 'cases.read'))).toBe('INVALID_CREDENTIAL');
	});

	it('rejects a wrong verifier, wrong redirect_uri, wrong client and expired codes', async () => {
		const s = await setup();
		const c = await connect(s);
		expect(await codeOf(exchange(s, c, { verifier: verifier() }))).toBe('invalid_grant');
		expect(await codeOf(exchange(s, c, { redirectUri: 'https://claude.ai/other' }))).toBe('invalid_grant');
		const other = await core.registerClient('Other', [REDIRECT]);
		expect(await codeOf(exchange(s, c, { clientId: other.client_id }))).toBe('invalid_grant');
		await sql`UPDATE oauth_auth_codes SET expires_at = now() - interval '1 second' WHERE grant_id = ${c.grantId}`;
		expect(await codeOf(exchange(s, c))).toBe('invalid_grant');
	});

	it('re-using an authorization code revokes the connection and raises a high alert', async () => {
		const s = await setup();
		const c = await connect(s);
		const t = await exchange(s, c);
		expect(await codeOf(exchange(s, c))).toBe('invalid_grant');
		expect(await codeOf(requireIntegrationPermission(bearer(t.access_token), 'cases.read', { allowOAuth: true }))).toBe('INVALID_CREDENTIAL');
		const alerts = (await listAlerts({ openOnly: true })).filter((a) => a.account_id === s.acct.id);
		expect(alerts.map((a) => [a.kind, a.severity])).toContainEqual(['oauth_code_reuse', 'high']);
	});

	it('rotates refresh tokens; presenting a rotated one revokes everything and alerts', async () => {
		const s = await setup();
		const c = await connect(s);
		const t1 = await exchange(s, c);
		const t2 = await core.refreshTokens({ refreshToken: t1.refresh_token, clientId: s.client.client_id });
		expect(t2.refresh_token).not.toBe(t1.refresh_token);
		await requireIntegrationPermission(bearer(t2.access_token), 'cases.read', { allowOAuth: true });
		// Stolen/old refresh token replayed:
		expect(await codeOf(core.refreshTokens({ refreshToken: t1.refresh_token, clientId: s.client.client_id }))).toBe('invalid_grant');
		expect(await codeOf(requireIntegrationPermission(bearer(t2.access_token), 'cases.read', { allowOAuth: true }))).toBe('INVALID_CREDENTIAL');
		expect(await codeOf(core.refreshTokens({ refreshToken: t2.refresh_token, clientId: s.client.client_id }))).toBe('invalid_grant');
		const kinds = (await listAlerts({ openOnly: true })).filter((a) => a.account_id === s.acct.id).map((a) => a.kind);
		expect(kinds).toContain('oauth_refresh_reuse');
	});

	it('a customer can revoke only their own account\'s connection, and it dies immediately', async () => {
		const s = await setup();
		const other = await setup();
		const c = await connect(s);
		const t = await exchange(s, c);
		expect(await core.revokeGrantForAccount(c.grantId, other.acct.id, null, 'x')).toBe(false); // foreign account → not found
		await requireIntegrationPermission(bearer(t.access_token), 'cases.read', { allowOAuth: true });
		expect(await core.revokeGrantForAccount(c.grantId, s.acct.id, s.owner.id, 'revoked by customer')).toBe(true);
		expect(await codeOf(requireIntegrationPermission(bearer(t.access_token), 'cases.read', { allowOAuth: true }))).toBe('INVALID_CREDENTIAL');
		expect((await core.listGrants(s.acct.id))[0].revoked_at).not.toBeNull();
	});

	it('RFC 7009 revoke-by-token kills the connection', async () => {
		const s = await setup();
		const t = await exchange(s, await connect(s));
		await core.revokeByToken(t.refresh_token);
		expect(await codeOf(requireIntegrationPermission(bearer(t.access_token), 'cases.read', { allowOAuth: true }))).toBe('INVALID_CREDENTIAL');
		await core.revokeByToken('adrt_unknown'); // unknown token is not an error
	});

	it('kill switches: global and per-account, and no new tokens while off', async () => {
		const s = await setup(false); // account switch is OFF by default
		expect(await mcpAvailable(s.acct.id)).toEqual({ ok: false, reason: 'account' });
		const c = await connect(s);
		expect(await codeOf(exchange(s, c))).toBe('access_denied');

		await sql`UPDATE accounts SET mcp_enabled = true WHERE id = ${s.acct.id}`;
		expect(await mcpAvailable(s.acct.id)).toEqual({ ok: true });
		await setGlobalMcpEnabled(false, 'test');
		expect(await mcpAvailable(s.acct.id)).toEqual({ ok: false, reason: 'global' });
		await setGlobalMcpEnabled(true, 'test');
		expect(await mcpAvailable(s.acct.id)).toEqual({ ok: true });
	});

	it('revokeAllGrants for an account only touches that account', async () => {
		const a = await setup();
		const b = await setup();
		await exchange(a, await connect(a));
		const tb = await exchange(b, await connect(b));
		expect(await core.revokeAllGrants({ accountId: a.acct.id }, 'test')).toBe(1);
		await requireIntegrationPermission(bearer(tb.access_token), 'cases.read', { allowOAuth: true });
	});

	it('alerts de-duplicate while open, can be acknowledged, and never contain raw credentials', async () => {
		const acct = await makeAccount();
		const input = { kind: 'mcp_repeated_denials' as const, severity: 'medium' as const, accountId: acct.id, subjectType: 'integration', subjectId: `i-${acct.id}`, message: 'probing' };
		expect(await raiseAlert(input)).toBe(true);
		expect(await raiseAlert(input)).toBe(false); // de-duplicated
		const [a] = (await listAlerts({ openOnly: true })).filter((x) => x.account_id === acct.id);
		await acknowledgeAlert(a.id, 'staff@x.test');
		expect(await raiseAlert(input)).toBe(true); // acknowledged → a new one may be raised
	});
});
