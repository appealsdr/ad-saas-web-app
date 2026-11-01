/**
 * Session creation + lookup backed by the `sessions` table.
 *
 * - Token: 32 random bytes encoded base64url → handed to client as a cookie.
 * - Hash:  SHA-256 of the token, stored in DB. Lookup hashes the incoming
 *          token and finds the row. The raw token never persists server-side,
 *          so a DB leak can't be used to impersonate.
 * - TTL:   3 hours by default (matches the existing cookie maxAge).
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../db';
import { logActivity } from '../activity';

const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

export interface NewSession {
	rawToken: string;     // give this to the client cookie
	sessionId: string;
	expiresAt: Date;
}

export interface SessionUser {
	userId: string;
	email: string;
	displayName: string | null;
	avatarUrl: string | null;
	accountId: string | null;
	sfdcContactId: string | null;
	sfdcAccountId: string | null;
	/** True for admin "view as user" sessions: browse only, no mutations. */
	readOnly: boolean;
	sessionId: string;
	/** Email of the platform admin who opened a read-only session. */
	impersonatedByEmail: string | null;
}

function hashToken(token: string): string {
	return createHash('sha256').update(token).digest('hex');
}

export async function createSession(
	userId: string,
	meta: {
		ipAddress?: string;
		userAgent?: string;
		/** Read-only "view as user" session opened by this platform staff user. */
		impersonatedBy?: string;
		ttlMs?: number;
	} = {}
): Promise<NewSession> {
	const rawToken = randomBytes(32).toString('base64url');
	const tokenHash = hashToken(rawToken);
	const expiresAt = new Date(Date.now() + (meta.ttlMs ?? SESSION_TTL_MS));

	const [row] = await sql<{ id: string }[]>`
		INSERT INTO sessions (user_id, token_hash, expires_at, ip_address, user_agent, read_only, impersonated_by)
		VALUES (${userId}, ${tokenHash}, ${expiresAt}, ${meta.ipAddress ?? null}, ${meta.userAgent ?? null},
		        ${!!meta.impersonatedBy}, ${meta.impersonatedBy ?? null})
		RETURNING id
	`;

	// Admin "view as user" sessions are not the customer's own activity.
	if (!meta.impersonatedBy) {
		logActivity({ userId, accountId: null, sessionId: row.id, type: 'login', data: { userAgent: (meta.userAgent ?? '').slice(0, 160) || undefined }, ip: meta.ipAddress });
	}
	return { rawToken, sessionId: row.id, expiresAt };
}

/**
 * Look up a session by its raw token (the cookie value). Returns null if the
 * token is unknown, the session has expired, or the user has been
 * deactivated. Expired rows are deleted opportunistically.
 */
export async function getSessionUser(rawToken: string): Promise<SessionUser | null> {
	if (!rawToken) return null;
	const tokenHash = hashToken(rawToken);

	const rows = await sql<
		{
			user_id: string;
			expires_at: Date;
			email: string;
			display_name: string | null;
			avatar_url: string | null;
			account_id: string | null;
			sfdc_contact_id: string | null;
			sfdc_account_id: string | null;
			is_active: boolean;
			read_only: boolean;
			session_id: string;
			imp_email: string | null;
		}[]
	>`
		SELECT s.user_id, s.expires_at,
		       u.email, u.display_name, u.avatar_url, u.account_id,
		       u.sfdc_contact_id, u.sfdc_account_id, u.is_active,
		       s.read_only, s.id AS session_id, imp.email AS imp_email
		FROM sessions s
		JOIN users u ON u.id = s.user_id
		LEFT JOIN platform_staff imp ON imp.user_id = s.impersonated_by
		WHERE s.token_hash = ${tokenHash}
		LIMIT 1
	`;

	const row = rows[0];
	if (!row) return null;

	if (row.expires_at.getTime() <= Date.now() || !row.is_active) {
		await sql`DELETE FROM sessions WHERE token_hash = ${tokenHash}`;
		return null;
	}

	return {
		userId: row.user_id,
		email: row.email,
		displayName: row.display_name,
		avatarUrl: row.avatar_url,
		accountId: row.account_id,
		sfdcContactId: row.sfdc_contact_id,
		sfdcAccountId: row.sfdc_account_id,
		readOnly: row.read_only,
		sessionId: row.session_id,
		impersonatedByEmail: row.imp_email
	};
}

export async function deleteSession(rawToken: string): Promise<void> {
	if (!rawToken) return;
	await sql`DELETE FROM sessions WHERE token_hash = ${hashToken(rawToken)}`;
}
