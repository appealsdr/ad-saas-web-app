import { describe, expect, it } from 'vitest';
import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeStaff, makeStore, makeUser, uniq } from '../setup/db';
import { ipAllowed, parseCidr, parseCidrList } from '$lib/server/integrations/ip';
import { INTEGRATION_PERMISSIONS, diffPermissions, normalizePermissions } from '$lib/server/integrations/permissions';

describe('permissions + ip helpers', () => {
	it('normalizes, dedupes, rejects unknown and empty lists', () => {
		expect(normalizePermissions(['cases.read', 'stores.list', 'cases.read'])).toEqual(['stores.list', 'cases.read']);
		expect(() => normalizePermissions(['stores.*'])).toThrow(/Unsupported/);
		expect(() => normalizePermissions([])).toThrow(/At least one/);
		expect(INTEGRATION_PERMISSIONS).toHaveLength(11);
	});
	it('diffs permissions safely', () => {
		expect(diffPermissions(['a', 'b'], ['b', 'c'])).toEqual({ addedPermissions: ['c'], removedPermissions: ['a'] });
	});
	it('parses and matches IPv4/IPv6 CIDRs, fails closed on unknown IP', () => {
		expect(parseCidr('10.0.0.0/24')).toBe('10.0.0.0/24');
		expect(parseCidr('1.2.3.4')).toBe('1.2.3.4/32');
		expect(parseCidr('1.2.3.4/33')).toBeNull();
		expect(() => parseCidrList('10.0.0.0/24, nope')).toThrow(/not a valid/);
		expect(ipAllowed([], '9.9.9.9')).toBe(true);
		expect(ipAllowed(['10.0.0.0/24'], '10.0.0.77')).toBe(true);
		expect(ipAllowed(['10.0.0.0/24'], '10.0.1.1')).toBe(false);
		expect(ipAllowed(['10.0.0.0/24'], '::ffff:10.0.0.5')).toBe(true);
		expect(ipAllowed(['2001:db8::/32'], '2001:db8::1')).toBe(true);
		expect(ipAllowed(['10.0.0.0/24'], null)).toBe(false);
	});
});

const d = describe.skipIf(!hasDb);

d('multi-integration API', async () => {
	const { createIntegration, updateIntegration, setIntegrationStatus, issueCredential, revokeCredential, pauseAllIntegrations, getIntegration, listIntegrations } =
		await import('$lib/server/integrations/service');
	const { requireIntegrationPermission, rateLimitKey } = await import('$lib/server/integrations/auth');
	const { withIdempotency } = await import('$lib/server/integrations/idempotency');
	const { requireIntegrationStore } = await import('$lib/server/integrations/resources');
	const { ApiError } = await import('$lib/server/integrations/errors');
	const { requireApiKey, issueApiKey } = await import('$lib/server/auth/api_key');
	const { apiRoute } = await import('$lib/server/integrations/http');

	const staff = await makeStaff('platform_admin');
	const ctx = { actor: { userId: staff.id, ref: staff.email, role: 'platform_admin' }, ip: '127.0.0.1' };
	const req = (key: string) => new Request('http://x/api/v1/stores', { headers: { authorization: `Bearer ${key}` } });
	const codeOf = async (p: Promise<unknown>) => {
		try { await p; return 'ok'; } catch (e) { return e instanceof ApiError ? e.code : `other:${(e as Error).message}`; }
	};

	async function setup() {
		const acct = await makeAccount();
		const john = await makeUser({ accountId: acct.id, role: 'owner' });
		const jane = await makeUser({ accountId: acct.id });
		return { acct, john, jane };
	}

	it('allows several integrations per account, each with its own profile, default user and credentials', async () => {
		const { acct, john, jane } = await setup();
		const erp = await createIntegration(ctx, acct.id, { name: 'Customer ERP', defaultUserId: john.id });
		const rep = await createIntegration(ctx, acct.id, { name: 'Reporting Tool', defaultUserId: jane.id, permissions: ['stores.list', 'cases.list'] });
		expect(erp.rawKey).toBeTruthy();
		expect(rep.rawKey).not.toBe(erp.rawKey);

		const a = (await getIntegration(acct.id, erp.id))!;
		const b = (await getIntegration(acct.id, rep.id))!;
		expect(a.permissions).toHaveLength(11); // new integration => all permissions by default
		expect(b.permissions).toEqual(['stores.list', 'cases.list']);
		expect(a.default_user_id).toBe(john.id);
		expect(b.default_user_id).toBe(jane.id);

		const pa = await requireIntegrationPermission(req(erp.rawKey!), 'cases.create');
		const pb = await requireIntegrationPermission(req(rep.rawKey!), 'stores.list');
		expect(pa).toMatchObject({ integrationId: erp.id, accountId: acct.id, defaultUserId: john.id, integrationName: 'Customer ERP', status: 'active' });
		expect(pb).toMatchObject({ integrationId: rep.id, defaultUserId: jane.id });
		// Reporting Tool cannot do what only the ERP profile allows — permissions are never combined.
		expect(await codeOf(requireIntegrationPermission(req(rep.rawKey!), 'cases.create'))).toBe('PERMISSION_DENIED');
		expect(await codeOf(requireIntegrationPermission(req(rep.rawKey!), 'stores.read'))).toBe('PERMISSION_DENIED'); // list does not imply read
	});

	it('names are unique per account (case-insensitive) but reusable across accounts; copy-from is explicit', async () => {
		const { acct, john } = await setup();
		const other = await setup();
		const first = await createIntegration(ctx, acct.id, { name: 'Uploader', defaultUserId: john.id, permissions: ['files.upload'] });
		await expect(createIntegration(ctx, acct.id, { name: 'uploader', defaultUserId: john.id })).rejects.toThrow(/already exists/);
		await createIntegration(ctx, other.acct.id, { name: 'Uploader', defaultUserId: other.john.id }); // other account: fine
		// A second integration does NOT silently inherit the first's profile…
		const second = await createIntegration(ctx, acct.id, { name: 'Second', defaultUserId: john.id });
		expect((await getIntegration(acct.id, second.id))!.permissions).toHaveLength(11);
		// …unless copying is explicitly requested.
		const third = await createIntegration(ctx, acct.id, { name: 'Third', defaultUserId: john.id, copyPermissionsFromId: first.id });
		expect((await getIntegration(acct.id, third.id))!.permissions).toEqual(['files.upload']);
		expect((await listIntegrations(acct.id)).length).toBe(3);
	});

	it('validates permissions, default user account and at-least-one rule (app + DB)', async () => {
		const { acct, john } = await setup();
		const other = await setup();
		await expect(createIntegration(ctx, acct.id, { name: 'X', defaultUserId: john.id, permissions: [] })).rejects.toThrow(/At least one/);
		await expect(createIntegration(ctx, acct.id, { name: 'X', defaultUserId: john.id, permissions: ['admin.all'] })).rejects.toThrow(/Unsupported/);
		await expect(createIntegration(ctx, acct.id, { name: 'X', defaultUserId: other.john.id })).rejects.toThrow(/user of this account/);
		// DB-level backstops bypassing the service:
		await expect(sql`INSERT INTO integration_clients (account_id, name, default_user_id, permissions) VALUES (${acct.id}, 'raw', ${john.id}, ${['bogus']})`).rejects.toThrow();
		await expect(sql`INSERT INTO integration_clients (account_id, name, default_user_id, permissions) VALUES (${acct.id}, 'raw2', ${john.id}, ${[]}::text[])`).rejects.toThrow();
		await expect(sql`INSERT INTO integration_clients (account_id, name, default_user_id, permissions) VALUES (${acct.id}, 'raw3', ${other.john.id}, ${['stores.list']})`).rejects.toThrow(/same account/);
	});

	it('changing one integration changes only that integration and audits a safe diff', async () => {
		const { acct, john } = await setup();
		const a = await createIntegration(ctx, acct.id, { name: 'A', defaultUserId: john.id });
		const b = await createIntegration(ctx, acct.id, { name: 'B', defaultUserId: john.id });
		await updateIntegration(ctx, acct.id, a.id, { name: 'A', defaultUserId: john.id, permissions: INTEGRATION_PERMISSIONS.filter((p) => p !== 'files.upload') });
		expect((await getIntegration(acct.id, a.id))!.permissions).not.toContain('files.upload');
		expect((await getIntegration(acct.id, b.id))!.permissions).toContain('files.upload');
		// takes effect on the next request without rotating the credential
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'files.upload'))).toBe('PERMISSION_DENIED');
		expect(await codeOf(requireIntegrationPermission(req(b.rawKey!), 'files.upload'))).toBe('ok');
		const [ev] = await sql<{ metadata: Record<string, unknown> }[]>`
			SELECT metadata FROM admin_audit_events WHERE action = 'integration.update' AND target_id = ${a.id}`;
		expect(ev.metadata).toMatchObject({ integrationId: a.id, removedPermissions: ['files.upload'], addedPermissions: [] });
		expect(JSON.stringify(ev.metadata)).not.toMatch(/adi_/);
	});

	it('pause/disable/revoke/rotate affect only the targeted integration or credential', async () => {
		const { acct, john } = await setup();
		const a = await createIntegration(ctx, acct.id, { name: 'A', defaultUserId: john.id });
		const b = await createIntegration(ctx, acct.id, { name: 'B', defaultUserId: john.id });

		await setIntegrationStatus(ctx, acct.id, a.id, 'pause', 'maintenance window');
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list'))).toBe('INTEGRATION_PAUSED');
		expect(await codeOf(requireIntegrationPermission(req(b.rawKey!), 'stores.list'))).toBe('ok');
		await setIntegrationStatus(ctx, acct.id, a.id, 'resume', null);
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list'))).toBe('ok');

		await setIntegrationStatus(ctx, acct.id, a.id, 'disable', 'decommissioned');
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list'))).toBe('INTEGRATION_DISABLED');
		expect(await codeOf(requireIntegrationPermission(req(b.rawKey!), 'stores.list'))).toBe('ok');
		await setIntegrationStatus(ctx, acct.id, a.id, 'resume', null);

		// Rotation: grace 24h keeps the old key alive; B's credentials are untouched either way.
		const rotated = await issueCredential(ctx, acct.id, a.id, 'v2', true);
		expect(rotated.retired).toBe(1);
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list'))).toBe('ok'); // within grace
		expect(await codeOf(requireIntegrationPermission(req(rotated.rawKey), 'stores.list'))).toBe('ok');
		expect(await codeOf(requireIntegrationPermission(req(b.rawKey!), 'stores.list'))).toBe('ok');
		// Revoke exactly the old credential.
		const [old] = await sql<{ id: string }[]>`SELECT id FROM integration_credentials WHERE integration_client_id = ${a.id} AND label = 'Initial credential'`;
		await revokeCredential(ctx, acct.id, a.id, old.id, 'old key retired');
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list'))).toBe('INVALID_CREDENTIAL');
		expect(await codeOf(requireIntegrationPermission(req(rotated.rawKey), 'stores.list'))).toBe('ok');
		// A credential id from another integration cannot be revoked through this one.
		const [bCred] = await sql<{ id: string }[]>`SELECT id FROM integration_credentials WHERE integration_client_id = ${b.id}`;
		await expect(revokeCredential(ctx, acct.id, a.id, bCred.id, 'wrong target')).rejects.toThrow(/not found/);
		expect(await codeOf(requireIntegrationPermission(req(b.rawKey!), 'stores.list'))).toBe('ok');
	});

	it('immediate rotation (grace 0) and expired credentials', async () => {
		const { acct, john } = await setup();
		const a = await createIntegration(ctx, acct.id, { name: 'A', defaultUserId: john.id, rotationGraceHours: 0 });
		const r = await issueCredential(ctx, acct.id, a.id, null, true);
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list'))).toBe('INVALID_CREDENTIAL');
		await sql`UPDATE integration_credentials SET expires_at = now() - interval '1 minute' WHERE integration_client_id = ${a.id} AND revoked_at IS NULL`;
		expect(await codeOf(requireIntegrationPermission(req(r.rawKey), 'stores.list'))).toBe('INVALID_CREDENTIAL');
	});

	it('enforces IP allowlist and isolates rate limits per integration', async () => {
		const { acct, john } = await setup();
		const a = await createIntegration(ctx, acct.id, { name: 'A', defaultUserId: john.id, allowedIps: '10.0.0.0/24', rateLimitPerMinute: 2 });
		const b = await createIntegration(ctx, acct.id, { name: 'B', defaultUserId: john.id, rateLimitPerMinute: 2 });
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list', { clientIp: '8.8.8.8' }))).toBe('IP_NOT_ALLOWED');
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list'))).toBe('IP_NOT_ALLOWED'); // unknown IP fails closed
		const okIp = { clientIp: '10.0.0.9' };
		// A's two denied attempts above stop before the limiter; now burn A's 2 requests.
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list', okIp))).toBe('ok');
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list', okIp))).toBe('ok');
		expect(await codeOf(requireIntegrationPermission(req(a.rawKey!), 'stores.list', okIp))).toBe('RATE_LIMITED');
		// B (same account) is unaffected by A being limited.
		expect(await codeOf(requireIntegrationPermission(req(b.rawKey!), 'stores.list'))).toBe('ok');
		expect(rateLimitKey('abc', 120_000)).toBe('api-integration:abc:2');
	});

	it('isolates idempotency keys per integration and replays within one', async () => {
		const { acct, john } = await setup();
		const a = await createIntegration(ctx, acct.id, { name: 'A', defaultUserId: john.id });
		const b = await createIntegration(ctx, acct.id, { name: 'B', defaultUserId: john.id });
		let runs = 0;
		const fn = async () => ({ status: 201, body: { n: ++runs } });
		const first = await withIdempotency(a.id, 'stores.create', 'key-1', 'h1', fn);
		const replay = await withIdempotency(a.id, 'stores.create', 'key-1', 'h1', fn);
		const otherIntegration = await withIdempotency(b.id, 'stores.create', 'key-1', 'h1', fn); // same key, independent namespace
		expect(first.replayed).toBe(false);
		expect(replay).toMatchObject({ replayed: true, body: { n: 1 } });
		expect(otherIntegration).toMatchObject({ replayed: false, body: { n: 2 } });
		expect(await codeOf(withIdempotency(a.id, 'stores.create', 'key-1', 'DIFFERENT', fn))).toBe('IDEMPOTENCY_KEY_REUSED');
	});

	it('resource checks stay inside the authenticated account even with identical names', async () => {
		const mine = await setup();
		const theirs = await setup();
		const myStore = await makeStore(mine.acct.id, 'Same Name');
		const theirStore = await makeStore(theirs.acct.id, 'Same Name');
		const a = await createIntegration(ctx, mine.acct.id, { name: 'Same Integration', defaultUserId: mine.john.id });
		await createIntegration(ctx, theirs.acct.id, { name: 'Same Integration', defaultUserId: theirs.john.id });
		const p = await requireIntegrationPermission(req(a.rawKey!), 'stores.read');
		expect((await requireIntegrationStore(p.accountId, myStore)).id).toBe(myStore);
		expect(await codeOf(requireIntegrationStore(p.accountId, theirStore))).toBe('NOT_FOUND');
	});

	it('full route: audits the exact integration/credential and never trusts a request-supplied integration id', async () => {
		const { acct, john, jane } = await setup();
		const a = await createIntegration(ctx, acct.id, { name: 'A', defaultUserId: john.id, permissions: ['stores.list'] });
		const b = await createIntegration(ctx, acct.id, { name: 'B', defaultUserId: jane.id, permissions: ['cases.list'] });
		await makeStore(acct.id, 'S1');
		const { GET } = await import('../../src/routes/api/v1/stores/+server');
		const call = (key: string | null, extra = '') =>
			GET({
				request: new Request(`http://x/api/v1/stores${extra}`, { headers: key ? { authorization: `Bearer ${key}` } : {} }),
				url: new URL(`http://x/api/v1/stores${extra}`), locals: { requestId: `req-${uniq()}` }, params: {}, getClientAddress: () => '203.0.113.5'
			} as never) as Promise<Response>;

		const ok = await call(a.rawKey!, `?integrationId=${b.id}`); // query-string id is ignored
		expect(ok.status).toBe(200);
		expect((await ok.json()).data).toHaveLength(1);
		const denied = await call(b.rawKey!);
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe('PERMISSION_DENIED');
		expect((await call(null)).status).toBe(401);

		const rows = await sql<{ integration_client_id: string; credential_id: string; default_user_id: string; outcome: string; required_permission: string; source_ip: string }[]>`
			SELECT integration_client_id, credential_id, default_user_id, outcome, required_permission, host(source_ip) AS source_ip
			FROM integration_audit_events WHERE account_id = ${acct.id} ORDER BY occurred_at`;
		expect(rows).toHaveLength(2); // unauthenticated call has no integration to attribute
		expect(rows[0]).toMatchObject({ integration_client_id: a.id, default_user_id: john.id, outcome: 'success', required_permission: 'stores.list', source_ip: '203.0.113.5' });
		expect(rows[1]).toMatchObject({ integration_client_id: b.id, default_user_id: jane.id, outcome: 'denied' });
		expect(rows[0].credential_id).not.toBe(rows[1].credential_id);
		expect(typeof apiRoute).toBe('function');
	});

	it('account-wide pause is a separate confirmed action recording one account-level event', async () => {
		const { acct, john } = await setup();
		const a = await createIntegration(ctx, acct.id, { name: 'A', defaultUserId: john.id });
		const b = await createIntegration(ctx, acct.id, { name: 'B', defaultUserId: john.id });
		await expect(pauseAllIntegrations(ctx, acct.id, 'incident response', 'nope')).rejects.toThrow(/PAUSE ALL/);
		await setIntegrationStatus(ctx, acct.id, a.id, 'pause', 'single pause only');
		expect((await getIntegration(acct.id, b.id))!.status).toBe('active'); // single pause never pauses siblings
		const ids = await pauseAllIntegrations(ctx, acct.id, 'incident response', 'PAUSE ALL');
		expect(ids).toEqual([b.id]); // only the still-active one changed
		const evs = await sql<{ metadata: { affectedIntegrationIds: string[] } }[]>`SELECT metadata FROM admin_audit_events WHERE action = 'integration.pause_all' AND target_account_id = ${acct.id}`;
		expect(evs).toHaveLength(1);
		expect(evs[0].metadata.affectedIntegrationIds).toEqual([b.id]);
	});

	it('Salesforce provisioning keys are separate and unchanged', async () => {
		const { rawKey } = await issueApiKey('sf-flow', ['provision']);
		const principal = await requireApiKey(req(rawKey), 'provision');
		expect(principal.scopes).toEqual(['provision']);
		// An integration credential is not a provisioning key, and vice versa.
		const { acct, john } = await setup();
		const i = await createIntegration(ctx, acct.id, { name: 'A', defaultUserId: john.id });
		await expect(requireApiKey(req(i.rawKey!), 'provision')).rejects.toBeTruthy();
		expect(await codeOf(requireIntegrationPermission(req(rawKey), 'stores.list'))).toBe('INVALID_CREDENTIAL');
	});
});

describe('route modules', () => {
	it('every /api/v1 +server.ts exports only names SvelteKit accepts (otherwise the route 500s at runtime)', async () => {
		const { readdirSync, readFileSync, statSync } = await import('node:fs');
		const { join } = await import('node:path');
		const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
		const files = walk(join(import.meta.dirname, '..', '..', 'src', 'routes', 'api', 'v1')).filter((f) => f.endsWith('+server.ts'));
		expect(files.length).toBeGreaterThanOrEqual(6);
		const allowed = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS', 'HEAD', 'fallback', 'prerender', 'trailingSlash', 'config', 'entries']);
		for (const f of files) {
			const names = [...readFileSync(f, 'utf8').matchAll(/^export\s+(?:async\s+)?(?:const|function|let|class)\s+(\w+)/gm)].map((m) => m[1]);
			for (const n of names) expect(allowed.has(n) || n.startsWith('_'), `${f} exports "${n}"`).toBe(true);
		}
	});
});
