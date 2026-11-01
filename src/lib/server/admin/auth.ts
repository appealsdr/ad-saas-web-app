/**
 * Staff authentication: password → MFA challenge/enrollment → admin session.
 *
 * Public responses are always generic ("Invalid email or password."): unknown
 * email, wrong password, inactive staff and unknown accounts are indistinguishable.
 * Real reasons go to the audit log. Rate limits are DB-backed (shared across
 * replicas) and deliberately do NOT lock the customer account.
 */
import { sql } from '../db';
import { hashPassword, verifyPassword } from '../auth/password';
import { recordAudit } from './audit';
import { newOpaqueToken, sha256Hex } from './crypto';
import { hitRateLimit } from './rate_limit';
import { ADMIN_CHALLENGE_TTL_MS } from './sessions';
import { getMfaState } from './mfa';

export const GENERIC_LOGIN_ERROR = 'Invalid email or password.';
export const MAX_LOGIN_PER_IP = 20;
export const MAX_LOGIN_PER_EMAIL = 5;
export const LOGIN_WINDOW_SECONDS = 15 * 60;
export const MAX_CHALLENGE_ATTEMPTS = 5;
export const MAX_MFA_PER_USER = 10;

let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashPassword('__admin-dummy__' + Math.random()));

/** Admin-only return URLs. Anything else falls back to /admin/accounts. */
export function safeAdminNext(next: string | null | undefined): string {
	const fallback = '/admin/accounts';
	if (!next) return fallback;
	const v = String(next).trim();
	if (v.length > 1024) return fallback;
	if (!/^\/admin(\/|\?|$)/.test(v)) return fallback;
	if (v.includes('//') || v.includes('://') || /[\u0000-\u001f\\]/.test(v)) return fallback;
	if (/^\/admin\/(login|mfa|logout)(\/|\?|$)/.test(v)) return fallback;
	return v;
}

export type LoginResult =
	| { ok: true; challengeToken: string; stage: 'mfa_enroll' | 'mfa_challenge' }
	| { ok: false; status: 400 | 401 | 429 | 503; message: string };

interface LoginRow {
	id: string;
	email: string;
	password_hash: string | null;
	must_reset_password: boolean;
	staff_active: boolean;
	role: string | null;
}

export async function startStaffLogin(input: {
	email: string;
	password: string;
	ip: string;
	next?: string | null;
}): Promise<LoginResult> {
	const email = input.email.trim().toLowerCase();
	const actorRef = email || 'anonymous';

	// Opportunistic housekeeping (best effort): short-lived admin state never accumulates.
	void sql`DELETE FROM admin_login_challenges WHERE expires_at < now() - interval '1 day'`.catch(() => {});
	void sql`DELETE FROM admin_rate_limits WHERE window_start < now() - interval '1 day'`.catch(() => {});
	void sql`DELETE FROM admin_sessions WHERE expires_at < now() - interval '30 days'`.catch(() => {});

	const ipLimit = await hitRateLimit(`admin-login:ip:${input.ip}`, MAX_LOGIN_PER_IP, LOGIN_WINDOW_SECONDS);
	const emailLimit = await hitRateLimit(`admin-login:email:${email.slice(0, 200)}`, MAX_LOGIN_PER_EMAIL, LOGIN_WINDOW_SECONDS);
	if (!ipLimit.allowed || !emailLimit.allowed) {
		await recordAudit(
			{ actor: { userId: null, ref: actorRef }, action: 'staff.login', outcome: 'denied', ip: input.ip, metadata: { reason: 'rate_limited' } },
			sql,
			{ bestEffort: true }
		);
		return { ok: false, status: 429, message: 'Too many attempts. Try again later.' };
	}
	if (!email || !input.password) return { ok: false, status: 400, message: 'Email and password are required.' };

	const rows = await sql<LoginRow[]>`
		SELECT ps.user_id AS id, ps.email, ps.password_hash, ps.must_reset_password, ps.is_active AS staff_active, ps.role
		FROM platform_staff ps
		WHERE lower(ps.email) = ${email} LIMIT 1
	`;
	const row = rows[0];
	const passwordOk = await verifyPassword(input.password, row?.password_hash ?? (await dummyHash()));

	const fail = async (reason: string) => {
		await recordAudit(
			{
				actor: { userId: row?.id ?? null, ref: actorRef, role: row?.role ?? null },
				action: 'staff.login',
				outcome: 'failure',
				ip: input.ip,
				metadata: { reason }
			},
			sql,
			{ bestEffort: true }
		);
		return { ok: false as const, status: 401 as const, message: GENERIC_LOGIN_ERROR };
	};

	if (!row || !row.password_hash || !passwordOk) return fail('bad_credentials');
	if (!row.staff_active || !row.role) return fail('staff_inactive');
	if (row.must_reset_password) return fail('password_reset_required');

	const mfa = await getMfaState(row.id);
	const stage = mfa.enrolled ? 'mfa_challenge' : 'mfa_enroll';
	const token = newOpaqueToken();
	await sql`
		INSERT INTO admin_login_challenges (token_hash, user_id, stage, next_path, expires_at, ip_address)
		VALUES (${sha256Hex(token)}, ${row.id}, ${stage}, ${input.next ? safeAdminNext(input.next) : null},
		        ${new Date(Date.now() + ADMIN_CHALLENGE_TTL_MS)},
		        ${/^[0-9a-fA-F:.]+$/.test(input.ip) ? input.ip : null})
	`;
	await recordAudit(
		{
			actor: { userId: row.id, ref: row.email, role: row.role },
			action: 'staff.login.password_ok',
			outcome: 'success',
			ip: input.ip,
			metadata: { stage }
		},
		sql,
		{ bestEffort: true }
	);
	return { ok: true, challengeToken: token, stage };
}

export interface Challenge {
	id: string;
	userId: string;
	email: string;
	role: string;
	stage: 'mfa_enroll' | 'mfa_challenge';
	nextPath: string | null;
	attempts: number;
}

/** Load a live (unexpired, unconsumed) challenge and re-validate staff membership. */
export async function loadChallenge(rawToken: string | undefined): Promise<Challenge | null> {
	if (!rawToken) return null;
	const rows = await sql<
		{ id: string; user_id: string; stage: 'mfa_enroll' | 'mfa_challenge'; next_path: string | null; attempts: number; email: string; role: string }[]
	>`
		SELECT c.id, c.user_id, c.stage, c.next_path, c.attempts, ps.email, ps.role
		FROM admin_login_challenges c
		JOIN platform_staff ps ON ps.user_id = c.user_id AND ps.is_active
		WHERE c.token_hash = ${sha256Hex(rawToken)}
		  AND c.consumed_at IS NULL AND c.expires_at > now()
		LIMIT 1
	`;
	const r = rows[0];
	if (!r) return null;
	return { id: r.id, userId: r.user_id, email: r.email, role: r.role, stage: r.stage, nextPath: r.next_path, attempts: r.attempts };
}

/** Count a failed attempt; returns false (and burns the challenge) once the cap is reached. */
export async function registerChallengeFailure(challengeId: string, userId: string): Promise<{ stillValid: boolean; limited: boolean }> {
	const [c] = await sql<{ attempts: number }[]>`
		UPDATE admin_login_challenges SET attempts = attempts + 1 WHERE id = ${challengeId} RETURNING attempts
	`;
	const userLimit = await hitRateLimit(`admin-mfa:user:${userId}`, MAX_MFA_PER_USER, LOGIN_WINDOW_SECONDS);
	const burned = (c?.attempts ?? 99) >= MAX_CHALLENGE_ATTEMPTS;
	if (burned) await sql`UPDATE admin_login_challenges SET consumed_at = now() WHERE id = ${challengeId}`;
	return { stillValid: !burned && userLimit.allowed, limited: !userLimit.allowed };
}

/** Atomically consume a challenge; true only for the single caller that wins. */
export async function consumeChallenge(challengeId: string): Promise<boolean> {
	const rows = await sql`
		UPDATE admin_login_challenges SET consumed_at = now()
		WHERE id = ${challengeId} AND consumed_at IS NULL AND expires_at > now()
		RETURNING id
	`;
	return rows.length === 1;
}
