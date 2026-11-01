import { afterAll, describe, expect, it } from 'vitest';
import { currentTotp } from '$lib/server/admin/mfa';
import { sql } from '$lib/server/db';
import { hasDb, makeStaff, makeUser, uniq, ensureBackupAdmin } from '../setup/db';
import { hashPassword } from '$lib/server/auth/password';
import { GENERIC_LOGIN_ERROR, consumeChallenge, loadChallenge, registerChallengeFailure, startStaffLogin } from '$lib/server/admin/auth';
import { consumeRecoveryCode, getOrCreateEnrollment, issueRecoveryCodes, verifyTotp } from '$lib/server/admin/mfa';
import {
	ADMIN_ABSOLUTE_LIFETIME_MS, createAdminSession, lookupAdminSession, markMfaFresh, revokeAdminSession, revokeAllAdminSessionsForUser
} from '$lib/server/admin/sessions';
import { createStaff, deactivateStaff, setStaffRole, resetStaffMfa, StaffError } from '$lib/server/admin/staff';

const d = describe.skipIf(!hasDb);
const ip = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

d('staff login', () => {
	it('unknown email, wrong password, and non-staff users get the SAME generic response', async () => {
		const staff = await makeStaff('platform_admin');
		const customer = await makeUser();
		const results = await Promise.all([
			startStaffLogin({ email: `nobody-${uniq()}@x.test`, password: 'whatever-long-1', ip: ip() }),
			startStaffLogin({ email: staff.email, password: 'wrong-password-1', ip: ip() }),
			startStaffLogin({ email: customer.email, password: customer.password, ip: ip() })
		]);
		for (const r of results) {
			expect(r.ok).toBe(false);
			if (!r.ok) {
				expect(r.status).toBe(401);
				expect(r.message).toBe(GENERIC_LOGIN_ERROR);
			}
		}
	});
	it('a customer with role admin/owner is NOT platform staff', async () => {
		for (const role of ['owner', 'admin'] as const) {
			const u = await makeUser({ role });
			const r = await startStaffLogin({ email: u.email, password: u.password, ip: ip() });
			expect(r.ok).toBe(false);
		}
	});
	it('correct password only yields an MFA challenge — no session, no data access', async () => {
		const s = await makeStaff('platform_admin');
		const r = await startStaffLogin({ email: s.email, password: s.password, ip: ip() });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.stage).toBe('mfa_challenge');
		const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM admin_sessions WHERE user_id = ${s.id}`;
		expect(n).toBe(0);
		expect(await lookupAdminSession(r.challengeToken)).toEqual({ status: 'none' }); // a challenge token is not a session
	});
	it('unenrolled staff get an enrollment stage', async () => {
		const s = await makeStaff('platform_viewer', { mfa: false });
		const r = await startStaffLogin({ email: s.email, password: s.password, ip: ip() });
		expect(r.ok && r.stage).toBe('mfa_enroll');
	});
	it('rate limits by email across attempts (and does not lock the customer account)', async () => {
		const s = await makeStaff('platform_viewer');
		const customer = await makeUser({ email: s.email }); // a customer with the SAME email
		const outcomes: number[] = [];
		for (let i = 0; i < 7; i++) {
			const r = await startStaffLogin({ email: s.email, password: 'bad-password-xx', ip: ip() });
			outcomes.push(r.ok ? 200 : r.status);
		}
		expect(outcomes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
		expect(outcomes.slice(5)).toEqual([429, 429]);
		const [u] = await sql<{ locked_until: Date | null; failed_login_attempts: number }[]>`SELECT locked_until, failed_login_attempts FROM users WHERE id = ${customer.id}`;
		expect(u.locked_until).toBeNull();
		expect(u.failed_login_attempts).toBe(0);
	});
	it('deactivated admins and admins needing a password reset are refused', async () => {
		const s = await makeStaff('platform_viewer');
		await sql`UPDATE platform_staff SET must_reset_password = true WHERE user_id = ${s.id}`;
		expect((await startStaffLogin({ email: s.email, password: s.password, ip: ip() })).ok).toBe(false);
		await sql`UPDATE platform_staff SET must_reset_password = false, is_active = false WHERE user_id = ${s.id}`;
		expect((await startStaffLogin({ email: s.email, password: s.password, ip: ip() })).ok).toBe(false);
		await ensureBackupAdmin();
	});
	it('records login outcomes in the audit log without passwords', async () => {
		const s = await makeStaff('platform_admin');
		await startStaffLogin({ email: s.email, password: 'NotThePassword-1', ip: ip() });
		const rows = await sql<{ metadata: unknown; outcome: string }[]>`SELECT metadata, outcome FROM admin_audit_events WHERE actor_ref = ${s.email} AND action = 'staff.login'`;
		expect(rows.length).toBeGreaterThan(0);
		expect(JSON.stringify(rows)).not.toContain('NotThePassword');
		expect(rows[0].outcome).toBe('failure');
	});
});

d('MFA', () => {
	it('TOTP replay is rejected; a code works once', async () => {
		const s = await makeStaff('platform_admin');
		const code = currentTotp(s.secret!);
		expect(await verifyTotp(s.id, code)).toBe(true);
		expect(await verifyTotp(s.id, code)).toBe(false); // same time step → replay
		expect(await verifyTotp(s.id, '000000')).toBe(false);
		expect(await verifyTotp(s.id, 'abcdef')).toBe(false);
	});
	it('concurrent verification of one code has exactly one winner', async () => {
		const s = await makeStaff('platform_admin');
		const code = currentTotp(s.secret!);
		const results = await Promise.all(Array.from({ length: 6 }, () => verifyTotp(s.id, code)));
		expect(results.filter(Boolean)).toHaveLength(1);
	});
	it('enrollment secret is stored encrypted, confirmed once, and cannot be re-shown', async () => {
		const s = await makeStaff('platform_admin', { mfa: false });
		const e = await getOrCreateEnrollment(s.id, s.email);
		const [row] = await sql<{ secret_encrypted: string; confirmed_at: Date | null }[]>`SELECT secret_encrypted, confirmed_at FROM admin_mfa_credentials WHERE user_id = ${s.id}`;
		expect(row.secret_encrypted).not.toContain(e.secret);
		expect(row.confirmed_at).toBeNull();
		expect(await verifyTotp(s.id, currentTotp(e.secret))).toBe(false); // challenge mode refuses an unconfirmed credential
		expect(await verifyTotp(s.id, currentTotp(e.secret), { confirm: true })).toBe(true);
		await expect(getOrCreateEnrollment(s.id, s.email)).rejects.toThrow(/already enrolled/);
	});
	it('recovery codes are single use and only hashes are stored', async () => {
		const s = await makeStaff('platform_admin');
		const codes = await issueRecoveryCodes(s.id);
		expect(codes).toHaveLength(10);
		const stored = await sql<{ code_hash: string }[]>`SELECT code_hash FROM admin_recovery_codes WHERE user_id = ${s.id}`;
		for (const c of codes) expect(stored.some((r) => r.code_hash.includes(c.replace('-', '')))).toBe(false);
		expect(await consumeRecoveryCode(s.id, codes[0])).toBe(true);
		expect(await consumeRecoveryCode(s.id, codes[0])).toBe(false);
		expect(await consumeRecoveryCode(s.id, 'ffffff-ffffff')).toBe(false);
		const race = await Promise.all(Array.from({ length: 5 }, () => consumeRecoveryCode(s.id, codes[1])));
		expect(race.filter(Boolean)).toHaveLength(1);
	});
	it('challenge: expired, over-attempted and replayed challenges fail', async () => {
		const s = await makeStaff('platform_admin');
		const mk = async () => {
			const r = await startStaffLogin({ email: s.email, password: s.password, ip: ip() });
			if (!r.ok) throw new Error('login failed');
			return r.challengeToken;
		};
		// expired
		let tok = await mk();
		await sql`UPDATE admin_login_challenges SET expires_at = now() - interval '1 second' WHERE user_id = ${s.id}`;
		expect(await loadChallenge(tok)).toBeNull();
		// consumed once
		tok = await mk();
		const c = (await loadChallenge(tok))!;
		expect(await consumeChallenge(c.id)).toBe(true);
		expect(await consumeChallenge(c.id)).toBe(false);
		expect(await loadChallenge(tok)).toBeNull();
		// attempt cap burns the challenge
		tok = await mk();
		const c2 = (await loadChallenge(tok))!;
		let valid = true;
		for (let i = 0; i < 5; i++) valid = (await registerChallengeFailure(c2.id, s.id)).stillValid;
		expect(valid).toBe(false);
		expect(await loadChallenge(tok)).toBeNull();
	});
});

d('admin sessions', () => {
	it('valid session resolves to staff identity with role; token is not stored raw', async () => {
		const s = await makeStaff('platform_viewer');
		const { rawToken } = await createAdminSession(s.id, { ip: '10.1.1.1', userAgent: 'vitest' });
		const r = await lookupAdminSession(rawToken);
		expect(r.status).toBe('ok');
		if (r.status === 'ok') {
			expect(r.staff.role).toBe('platform_viewer');
			expect(r.staff.userId).toBe(s.id);
			expect(r.staff.freshMfa).toBe(true);
		}
		const rows = await sql<{ token_hash: string }[]>`SELECT token_hash FROM admin_sessions WHERE user_id = ${s.id}`;
		expect(rows.some((x) => x.token_hash === rawToken)).toBe(false);
	});
	it('customer session tokens never authenticate as admin', async () => {
		const c = await makeUser();
		await sql`INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (${c.id}, 'customer-hash', now() + interval '1 hour')`;
		expect((await lookupAdminSession('customer-hash')).status).toBe('none');
	});
	it('idle timeout (20 min) is enforced server-side', async () => {
		const s = await makeStaff('platform_admin');
		const { rawToken, sessionId } = await createAdminSession(s.id);
		await sql`UPDATE admin_sessions SET last_activity_at = now() - interval '21 minutes' WHERE id = ${sessionId}`;
		expect((await lookupAdminSession(rawToken)).status).toBe('expired');
	});
	it('absolute lifetime (8 h) is enforced even with constant activity', async () => {
		const s = await makeStaff('platform_admin');
		const { rawToken, sessionId, expiresAt } = await createAdminSession(s.id);
		expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(ADMIN_ABSOLUTE_LIFETIME_MS);
		await sql`UPDATE admin_sessions SET expires_at = now() - interval '1 second', last_activity_at = now() WHERE id = ${sessionId}`;
		expect((await lookupAdminSession(rawToken)).status).toBe('expired');
	});
	it('logout / revocation takes effect on the next request', async () => {
		const s = await makeStaff('platform_admin');
		const { rawToken } = await createAdminSession(s.id);
		await revokeAdminSession(rawToken, 'logout');
		expect((await lookupAdminSession(rawToken)).status).toBe('revoked');
	});
	it('staff deactivation fails the next protected request, and a same-email customer being suspended does not', async () => {
		await ensureBackupAdmin();
		const s = await makeStaff('platform_admin');
		const customer = await makeUser({ email: s.email });
		const { rawToken } = await createAdminSession(s.id);
		await sql`UPDATE users SET is_active = false WHERE id = ${customer.id}`; // separate identity: no effect on the admin
		expect((await lookupAdminSession(rawToken)).status).toBe('ok');
		await sql`UPDATE platform_staff SET is_active = false WHERE user_id = ${s.id}`;
		expect((await lookupAdminSession(rawToken)).status).toBe('membership');
	});
	it('role change is picked up immediately (viewer cannot keep admin rights)', async () => {
		await ensureBackupAdmin();
		const s = await makeStaff('platform_admin');
		const { rawToken } = await createAdminSession(s.id);
		await sql`UPDATE platform_staff SET role = 'platform_viewer' WHERE user_id = ${s.id}`;
		const r = await lookupAdminSession(rawToken);
		expect(r.status === 'ok' && r.staff.role).toBe('platform_viewer');
	});
	it('freshness: MFA is stale after 5 minutes until re-verified', async () => {
		const s = await makeStaff('platform_admin');
		const { rawToken, sessionId } = await createAdminSession(s.id);
		await sql`UPDATE admin_sessions SET mfa_verified_at = now() - interval '6 minutes' WHERE id = ${sessionId}`;
		let r = await lookupAdminSession(rawToken);
		expect(r.status === 'ok' && r.staff.freshMfa).toBe(false);
		await markMfaFresh(sessionId);
		r = await lookupAdminSession(rawToken);
		expect(r.status === 'ok' && r.staff.freshMfa).toBe(true);
	});
	it('password reset revokes admin sessions (SQL used by the reset flow) / MFA reset + role change revoke too', async () => {
		await ensureBackupAdmin();
		const s = await makeStaff('platform_admin');
		const a = await createAdminSession(s.id);
		const n = await revokeAllAdminSessionsForUser(s.id, 'password_reset');
		expect(n).toBeGreaterThan(0);
		expect((await lookupAdminSession(a.rawToken)).status).toBe('revoked');
		const b = await createAdminSession(s.id);
		await resetStaffMfa({ userId: s.id, actor: { userId: null, ref: 'test' }, reason: 'lost device' });
		expect((await lookupAdminSession(b.rawToken)).status).toBe('revoked');
		const [m] = await sql`SELECT 1 FROM admin_mfa_credentials WHERE user_id = ${s.id}`;
		expect(m).toBeUndefined();
	});
});

d('staff membership & last-admin protection', () => {
	const actor = { userId: null, ref: 'test-actor' };
	afterAll(async () => { await ensureBackupAdmin(); });

	it('concurrent demotions/deactivations can never remove the last active platform_admin', async () => {
		// Make exactly two active admins by deactivating everyone else, then race them.
		const a = await makeStaff('platform_admin');
		const b = await makeStaff('platform_admin');
		await sql`ALTER TABLE platform_staff DISABLE TRIGGER trg_platform_staff_last_admin`;
		await sql`UPDATE platform_staff SET is_active = false WHERE user_id NOT IN (${a.id}, ${b.id})`;
		await sql`ALTER TABLE platform_staff ENABLE TRIGGER trg_platform_staff_last_admin`;
		try {
			const results = await Promise.allSettled([
				deactivateStaff({ userId: a.id, actor, reason: 'race one' }),
				deactivateStaff({ userId: b.id, actor, reason: 'race two' }),
				setStaffRole({ email: a.email, role: 'platform_viewer', actor }),
				setStaffRole({ email: b.email, role: 'platform_viewer', actor })
			]);
			const [{ n }] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM platform_staff WHERE role='platform_admin' AND is_active`;
			expect(n).toBeGreaterThanOrEqual(1);
			const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
			expect(rejected.length).toBeGreaterThanOrEqual(1);
			for (const r of rejected) expect(r.reason).toBeInstanceOf(StaffError);
		} finally {
			await sql`ALTER TABLE platform_staff DISABLE TRIGGER trg_platform_staff_last_admin`;
			await sql`UPDATE platform_staff SET is_active = true, role = 'platform_admin' WHERE user_id IN (${a.id}, ${b.id})`;
			await sql`ALTER TABLE platform_staff ENABLE TRIGGER trg_platform_staff_last_admin`;
		}
	});
	it('the DB trigger blocks removal even for raw SQL (defence in depth)', async () => {
		const only = await makeStaff('platform_admin');
		await sql`ALTER TABLE platform_staff DISABLE TRIGGER trg_platform_staff_last_admin`;
		await sql`UPDATE platform_staff SET is_active = false WHERE user_id <> ${only.id} AND role = 'platform_admin'`;
		await sql`ALTER TABLE platform_staff ENABLE TRIGGER trg_platform_staff_last_admin`;
		await expect(sql`UPDATE platform_staff SET is_active = false WHERE user_id = ${only.id}`).rejects.toThrow(/last active platform_admin/);
		await expect(sql`DELETE FROM platform_staff WHERE user_id = ${only.id}`).rejects.toThrow(/last active platform_admin/);
		await expect(sql`UPDATE platform_staff SET role = 'platform_viewer' WHERE user_id = ${only.id}`).rejects.toThrow(/last active platform_admin/);
		await ensureBackupAdmin();
	});
	it('role change is idempotent, only applies to an existing platform admin, and audits', async () => {
		const s = await makeStaff('platform_admin');
		const r1 = await setStaffRole({ email: s.email.toUpperCase(), role: 'platform_viewer', actor, reason: 'least privilege' });
		const r2 = await setStaffRole({ email: s.email, role: 'platform_viewer', actor });
		expect(r1.changed).toBe(true);
		expect(r2.changed).toBe(false);
		await expect(setStaffRole({ email: `ghost-${uniq()}@x.test`, role: 'platform_admin', actor })).rejects.toThrow(/No platform admin/);
		// a customer user is NOT promotable
		const customer = await makeUser();
		await expect(setStaffRole({ email: customer.email, role: 'platform_admin', actor })).rejects.toThrow(/No platform admin/);
		const [a] = await sql`SELECT 1 FROM admin_audit_events WHERE action = 'staff.grant' AND target_id = ${s.id}`;
		expect(a).toBeDefined();
		await ensureBackupAdmin();
	});
	it('an admin is a separate identity: it can use exactly the same email as a customer, each with its own password', async () => {
		const customer = await makeUser({ password: 'Customer-Password-1!' });
		const created = await createStaff({ email: customer.email.toUpperCase(), displayName: 'Same Email Admin', role: 'platform_viewer', passwordHash: await hashPassword('Admin-Password-Different-9'), actor });
		expect(created.userId).not.toBe(customer.id); // never the customer's id
		// the admin password opens the admin console, the customer password does not
		const ok = await startStaffLogin({ email: customer.email, password: 'Admin-Password-Different-9', ip: ip() });
		expect(ok.ok).toBe(true);
		const bad = await startStaffLogin({ email: customer.email, password: 'Customer-Password-1!', ip: ip() });
		expect(bad.ok).toBe(false);
		// and the customer record is untouched (still a normal customer user)
		const [u] = await sql<{ role: string; email: string }[]>`SELECT role, email FROM users WHERE id = ${customer.id}`;
		expect(u.email).toBe(customer.email);
		// a second admin with the same email is refused
		await expect(createStaff({ email: customer.email, role: 'platform_viewer', passwordHash: 'x', actor })).rejects.toThrow(/already exists/);
		await expect(createStaff({ email: 'not-an-email', role: 'platform_viewer', passwordHash: 'x', actor })).rejects.toThrow(/valid email/);
	});
});
