/**
 * Admin sessions (admin_sessions) — fully separate from customer sessions.
 *
 *  - opaque 32-byte token in the `admin_session` cookie; only its SHA-256 is stored
 *  - idle timeout 20 min, absolute lifetime 8 h, enforced server-side per request
 *  - membership (platform_staff.is_active) is re-checked on
 *    EVERY request by the same query that loads the session (fail closed)
 *  - tokens are minted only after password + MFA (see auth.ts); a new token is
 *    issued each completed authentication (rotation)
 */
import type { Cookies } from '@sveltejs/kit';
import type { Sql } from 'postgres';
import { dev } from '$app/environment';
import { sql } from '../db';
import { newOpaqueToken, sha256Hex } from './crypto';
import { isPlatformRole, type PlatformRole } from './permissions';

export const ADMIN_SESSION_COOKIE = 'admin_session';
export const ADMIN_CHALLENGE_COOKIE = 'admin_challenge';

export const ADMIN_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
export const ADMIN_ABSOLUTE_LIFETIME_MS = 8 * 60 * 60 * 1000;
export const ADMIN_FRESH_MFA_MS = 5 * 60 * 1000;
export const ADMIN_CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface StaffContext {
	userId: string;
	email: string;
	displayName: string | null;
	role: PlatformRole;
	sessionId: string;
	mfaVerifiedAt: Date;
	/** true when MFA was (re)verified within ADMIN_FRESH_MFA_MS */
	freshMfa: boolean;
}

export type SessionLookup =
	| { status: 'ok'; staff: StaffContext }
	| { status: 'none' | 'expired' | 'revoked' | 'membership' };

export async function createAdminSession(
	userId: string,
	meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<{ rawToken: string; sessionId: string; expiresAt: Date }> {
	const rawToken = newOpaqueToken();
	const expiresAt = new Date(Date.now() + ADMIN_ABSOLUTE_LIFETIME_MS);
	const [row] = await sql<{ id: string }[]>`
		INSERT INTO admin_sessions (user_id, token_hash, mfa_verified_at, expires_at, ip_address, user_agent)
		VALUES (${userId}, ${sha256Hex(rawToken)}, now(), ${expiresAt},
		        ${meta.ip && /^[0-9a-fA-F:.]+$/.test(meta.ip) ? meta.ip : null},
		        ${meta.userAgent?.slice(0, 400) ?? null})
		RETURNING id
	`;
	return { rawToken, sessionId: row.id, expiresAt };
}

interface SessionRow {
	session_id: string;
	user_id: string;
	mfa_verified_at: Date;
	last_activity_at: Date;
	expires_at: Date;
	revoked_at: Date | null;
	email: string;
	display_name: string | null;
	staff_active: boolean | null;
	role: string | null;
}

export async function lookupAdminSession(rawToken: string | undefined): Promise<SessionLookup> {
	if (!rawToken) return { status: 'none' };
	const rows = await sql<SessionRow[]>`
		SELECT s.id AS session_id, s.user_id, s.mfa_verified_at, s.last_activity_at,
		       s.expires_at, s.revoked_at,
		       ps.email, ps.display_name, ps.is_active AS staff_active, ps.role
		FROM admin_sessions s
		JOIN platform_staff ps ON ps.user_id = s.user_id
		WHERE s.token_hash = ${sha256Hex(rawToken)}
		LIMIT 1
	`;
	const r = rows[0];
	if (!r) return { status: 'none' };
	if (r.revoked_at) return { status: 'revoked' };
	const now = Date.now();
	if (r.expires_at.getTime() <= now) return { status: 'expired' };
	if (now - r.last_activity_at.getTime() > ADMIN_IDLE_TIMEOUT_MS) return { status: 'expired' };
	if (!r.staff_active || !isPlatformRole(r.role)) return { status: 'membership' };

	// Touch last_activity (throttled to once per 30s to keep this cheap).
	if (now - r.last_activity_at.getTime() > 30_000) {
		await sql`UPDATE admin_sessions SET last_activity_at = now() WHERE id = ${r.session_id}`;
	}
	return {
		status: 'ok',
		staff: {
			userId: r.user_id,
			email: r.email,
			displayName: r.display_name,
			role: r.role,
			sessionId: r.session_id,
			mfaVerifiedAt: r.mfa_verified_at,
			freshMfa: now - r.mfa_verified_at.getTime() <= ADMIN_FRESH_MFA_MS
		}
	};
}

export async function revokeAdminSession(rawToken: string, reason: string, by?: string | null): Promise<void> {
	await sql`
		UPDATE admin_sessions SET revoked_at = now(), revoked_reason = ${reason}, revoked_by = ${by ?? null}
		WHERE token_hash = ${sha256Hex(rawToken)} AND revoked_at IS NULL
	`;
}

/** Revoke every live admin session for a user (deactivation, role change, password/MFA reset). */
export async function revokeAllAdminSessionsForUser(
	userId: string,
	reason: string,
	by?: string | null,
	db: Sql = sql
): Promise<number> {
	const rows = await db`
		UPDATE admin_sessions SET revoked_at = now(), revoked_reason = ${reason}, revoked_by = ${by ?? null}
		WHERE user_id = ${userId} AND revoked_at IS NULL
		RETURNING id
	`;
	return rows.length;
}

export async function markMfaFresh(sessionId: string): Promise<void> {
	await sql`UPDATE admin_sessions SET mfa_verified_at = now() WHERE id = ${sessionId}`;
}

// ─── Cookies ─────────────────────────────────────────────────────────────

export function setAdminSessionCookie(cookies: Cookies, rawToken: string): void {
	cookies.set(ADMIN_SESSION_COOKIE, rawToken, {
		path: '/',
		httpOnly: true,
		secure: !dev,
		sameSite: 'strict',
		maxAge: Math.floor(ADMIN_ABSOLUTE_LIFETIME_MS / 1000)
	});
}

export function clearAdminSessionCookie(cookies: Cookies): void {
	cookies.delete(ADMIN_SESSION_COOKIE, { path: '/', httpOnly: true, secure: !dev, sameSite: 'strict' });
}

export function setChallengeCookie(cookies: Cookies, rawToken: string): void {
	cookies.set(ADMIN_CHALLENGE_COOKIE, rawToken, {
		path: '/admin',
		httpOnly: true,
		secure: !dev,
		sameSite: 'strict',
		maxAge: Math.floor(ADMIN_CHALLENGE_TTL_MS / 1000)
	});
}

export function clearChallengeCookie(cookies: Cookies): void {
	cookies.delete(ADMIN_CHALLENGE_COOKIE, { path: '/admin', httpOnly: true, secure: !dev, sameSite: 'strict' });
}
