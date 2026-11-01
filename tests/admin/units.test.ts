import { describe, expect, it } from 'vitest';
import { redactString, redactValue } from '$lib/server/admin/redact';
import { roleHas, type Permission } from '$lib/server/admin/permissions';
import { safeAdminNext } from '$lib/server/admin/auth';
import { decryptSecret, encryptSecret } from '$lib/server/admin/crypto';
import { adminOriginOk } from '$lib/server/admin/origin';
import { decodeCursor, encodeCursor } from '$lib/server/admin/logs';
import { likeContains, parsePageSize } from '$lib/server/admin/pagination';
import { requireStaff } from '$lib/server/admin/guard';
import type { StaffContext } from '$lib/server/admin/sessions';

describe('redaction', () => {
	it('redacts secret keys at any depth, including arrays', () => {
		const out = redactValue({
			a: 1,
			password: 'hunter2',
			nested: { api_key: 'abc', list: [{ refresh_token: 'r' }, { ok: 'fine' }], Authorization: 'Bearer abcdefghijkl' },
			x: { y: { z: { client_secret: 's' } } }
		}) as any;
		expect(out.password).toBe('[REDACTED]');
		expect(out.nested.api_key).toBe('[REDACTED]');
		expect(out.nested.list[0].refresh_token).toBe('[REDACTED]');
		expect(out.nested.list[1].ok).toBe('fine');
		expect(out.nested.Authorization).toBe('[REDACTED]');
		expect(out.x.y.z.client_secret).toBe('[REDACTED]');
		expect(out.a).toBe(1);
	});
	it('redacts secrets embedded in strings and stacks', () => {
		const s = redactString(
			[
				'failed with Bearer abcdefghijklmnop',
				'postgres://user:p4ssw0rd@db.internal:5432/x',
				'sk_live_abcdefghijklmnop',
				'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk',
				'password=hunter2 token: abc123 url?token=zzz&x=1',
				'-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----',
				'AKIAABCDEFGHIJKLMNOP'
			].join('\n')
		);
		for (const leak of ['abcdefghijklmnop', 'p4ssw0rd', 'hunter2', 'abc123', 'zzz', 'MIIEvQIBADANBg', 'AKIAABCDEFGHIJKLMNOP', 'eyJzdWIi'])
			expect(s).not.toContain(leak);
	});
	it('keeps ordinary stack traces readable', () => {
		const stack = 'Error: boom\n    at /Users/dev/project/node_modules/postgres/src/connection.js:123:45';
		expect(redactString(stack)).toBe(stack);
	});
	it('handles circular references', () => {
		const a: any = { n: 1 };
		a.self = a;
		expect(() => redactValue(a)).not.toThrow();
	});
});

describe('permission map', () => {
	const all: Permission[] = ['accounts.read', 'accounts.update', 'users.read', 'users.manage', 'logs.read', 'data.read', 'data.query', 'staff.manage'];
	it('platform_admin has everything', () => all.forEach((p) => expect(roleHas('platform_admin', p)).toBe(true)));
	it('platform_viewer is read-only', () => {
		for (const p of ['accounts.read', 'users.read', 'logs.read', 'data.read'] as const) expect(roleHas('platform_viewer', p)).toBe(true);
		for (const p of ['accounts.update', 'users.manage', 'data.query', 'staff.manage'] as const) expect(roleHas('platform_viewer', p)).toBe(false);
	});
	it('customer roles and unknown values have no platform permissions', () => {
		for (const r of ['owner', 'admin', 'member', undefined, null, '', 'platform_superuser'])
			all.forEach((p) => expect(roleHas(r as any, p)).toBe(false));
	});
});

describe('admin-only return URLs', () => {
	it('accepts admin deep links', () => {
		expect(safeAdminNext('/admin/accounts/abc?x=1')).toBe('/admin/accounts/abc?x=1');
		expect(safeAdminNext('/admin/logs')).toBe('/admin/logs');
	});
	it('rejects everything else', () => {
		for (const bad of ['/dashboard', '//evil.com', 'https://evil.com', '/admin//evil', '/adminx', '/admin/../x/\r\nSet-Cookie:a=b', '/admin\\evil', 'javascript:alert(1)', '/admin/login', '/admin/mfa', null, undefined, ''])
			expect(safeAdminNext(bad as any), String(bad)).toBe('/admin/accounts');
	});
});

describe('TOTP secret encryption', () => {
	it('round-trips and is non-deterministic', () => {
		const a = encryptSecret('JBSWY3DPEHPK3PXP');
		expect(a).not.toContain('JBSWY3DPEHPK3PXP');
		expect(a).not.toBe(encryptSecret('JBSWY3DPEHPK3PXP'));
		expect(decryptSecret(a)).toBe('JBSWY3DPEHPK3PXP');
	});
	it('detects tampering', () => {
		const parts = encryptSecret('x'.repeat(20)).split('.');
		parts[4] = Buffer.from('tampered-bytes-here').toString('base64url');
		expect(() => decryptSecret(parts.join('.'))).toThrow();
	});
	it('supports key rotation via the previous key', () => {
		const old = process.env.ADMIN_MFA_ENCRYPTION_KEY;
		const ct = encryptSecret('SECRET123');
		process.env.ADMIN_MFA_ENCRYPTION_KEY = '22'.repeat(32);
		expect(() => decryptSecret(ct)).toThrow(); // old key not configured
		process.env.ADMIN_MFA_ENCRYPTION_KEY_PREVIOUS = old;
		expect(decryptSecret(ct)).toBe('SECRET123');
		delete process.env.ADMIN_MFA_ENCRYPTION_KEY_PREVIOUS;
		process.env.ADMIN_MFA_ENCRYPTION_KEY = old;
	});
});

describe('CSRF / origin check', () => {
	const base = { requestOrigin: 'https://app.example.com', configuredOrigin: undefined, secFetchSite: null };
	it('allows safe methods', () => expect(adminOriginOk({ ...base, method: 'GET', origin: null })).toBe(true));
	it('allows same-origin POST', () => expect(adminOriginOk({ ...base, method: 'POST', origin: 'https://app.example.com' })).toBe(true));
	it('rejects cross-origin POST', () => expect(adminOriginOk({ ...base, method: 'POST', origin: 'https://evil.com' })).toBe(false));
	it('rejects POST with no origin unless same-origin fetch metadata', () => {
		expect(adminOriginOk({ ...base, method: 'POST', origin: null })).toBe(false);
		expect(adminOriginOk({ ...base, method: 'POST', origin: null, secFetchSite: 'cross-site' })).toBe(false);
		expect(adminOriginOk({ ...base, method: 'POST', origin: null, secFetchSite: 'same-origin' })).toBe(true);
	});
	it('honours the configured ORIGIN behind a proxy', () => {
		expect(adminOriginOk({ method: 'POST', origin: 'https://admin.example.com', requestOrigin: 'http://10.0.0.5:3000', configuredOrigin: 'https://admin.example.com', secFetchSite: null })).toBe(true);
	});
});

describe('pagination helpers', () => {
	it('round-trips cursors and rejects garbage', () => {
		const c = { t: '2026-01-02T03:04:05.123456Z', i: '11111111-1111-1111-1111-111111111111' };
		expect(decodeCursor(encodeCursor(c))).toEqual(c);
		expect(decodeCursor('not-base64-json')).toBeNull();
		expect(decodeCursor(Buffer.from(JSON.stringify({ t: "x'; drop", i: 'y' })).toString('base64url'))).toBeNull();
	});
	it('caps page size at 100 and escapes LIKE wildcards', () => {
		expect(parsePageSize('5000')).toBe(100);
		expect(parsePageSize('abc')).toBe(25);
		expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
	});
});

describe('requireStaff (fail closed)', () => {
	const ctx = (role: StaffContext['role'], freshMfa = true): StaffContext => ({
		userId: 'u', email: 'e@x', displayName: null, role, sessionId: 's', mfaVerifiedAt: new Date(), freshMfa
	});
	const ev = (staff: StaffContext | null, method = 'GET') =>
		({ locals: { staff }, url: new URL('http://x/admin/data?a=1'), request: new Request('http://x', { method }) }) as any;
	const thrown = (fn: () => unknown): any => { try { fn(); } catch (e) { return e; } throw new Error('did not throw'); };

	it('anonymous page → redirect to login preserving admin deep link', () => {
		const e = thrown(() => requireStaff(ev(null), 'accounts.read'));
		expect(e.status).toBe(303);
		expect(e.location).toBe('/admin/login?next=%2Fadmin%2Fdata%3Fa%3D1');
	});
	it('anonymous mutation → 401, not a redirect', () => expect(thrown(() => requireStaff(ev(null, 'POST'), 'accounts.update')).status).toBe(401));
	it('viewer denied SQL and mutations (403)', () => {
		for (const p of ['data.query', 'accounts.update', 'users.manage', 'staff.manage'] as const)
			expect(thrown(() => requireStaff(ev(ctx('platform_viewer')), p)).status).toBe(403);
		expect(requireStaff(ev(ctx('platform_viewer')), 'data.read').role).toBe('platform_viewer');
	});
	it('stale MFA blocks membership changes', () => {
		expect(thrown(() => requireStaff(ev(ctx('platform_admin', false), 'POST'), 'staff.manage', { freshMfa: true })).status).toBe(403);
		expect(thrown(() => requireStaff(ev(ctx('platform_admin', false)), 'staff.manage', { freshMfa: true })).location).toContain('/admin/reauth');
		expect(requireStaff(ev(ctx('platform_admin', true)), 'staff.manage', { freshMfa: true }).role).toBe('platform_admin');
	});
});
