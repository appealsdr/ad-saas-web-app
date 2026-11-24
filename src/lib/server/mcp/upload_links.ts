/**
 * One-time upload links (AD-1969). `create_upload_link` hands the customer a URL; the page behind it takes ONE real file
 * for ONE required-file slot. Security properties:
 *  - 256-bit random token, only its SHA-256 is stored; the link works once and expires after 15 minutes;
 *  - bound to the account / store / case / slot it was created for (never taken from the browser);
 *  - the upload itself reuses storeRequiredFileUpload (format + content sniffing + virus scan + audit rules);
 *  - the connector kill switches (global + account) apply to links too.
 */
import { createHash, randomBytes } from 'node:crypto';
import { sql } from '../db';

export const UPLOAD_LINK_TTL_MS = 15 * 60 * 1000;
export const MAX_ACTIVE_LINKS_PER_INTEGRATION = 20;

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export interface UploadLink {
	id: string;
	account_id: string;
	store_id: string;
	sfdc_case_id: string | null;
	required_file_id: string;
	replace_existing: boolean;
	created_by_user_id: string;
	integration_id: string | null;
	expires_at: Date;
}

export interface NewUploadLink {
	accountId: string;
	storeId: string;
	caseId: string | null;
	requiredFileId: string;
	replaceExisting: boolean;
	userId: string;
	integrationId: string;
}

/** Returns the raw token (shown once, never stored) or null when the integration already has too many open links. */
export async function createUploadLink(n: NewUploadLink, now = Date.now()): Promise<{ token: string; expiresAt: Date } | null> {
	const [active] = await sql<{ n: number }[]>`
		SELECT count(*)::int AS n FROM upload_links
		WHERE integration_id = ${n.integrationId} AND used_at IS NULL AND expires_at > ${new Date(now)}`;
	if ((active?.n ?? 0) >= MAX_ACTIVE_LINKS_PER_INTEGRATION) return null;
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(now + UPLOAD_LINK_TTL_MS);
	await sql`
		INSERT INTO upload_links (token_hash, account_id, store_id, sfdc_case_id, required_file_id, replace_existing, created_by_user_id, integration_id, expires_at)
		VALUES (${hashToken(token)}, ${n.accountId}, ${n.storeId}, ${n.caseId}, ${n.requiredFileId}, ${n.replaceExisting}, ${n.userId}, ${n.integrationId}, ${expiresAt})`;
	return { token, expiresAt };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** The link if it exists, is unused and unexpired; otherwise null (callers must not say which). */
export async function findUsableLink(token: string, now = Date.now()): Promise<UploadLink | null> {
	if (!TOKEN_RE.test(token)) return null;
	const [row] = await sql<UploadLink[]>`
		SELECT id, account_id, store_id, sfdc_case_id, required_file_id, replace_existing, created_by_user_id, integration_id, expires_at
		FROM upload_links WHERE token_hash = ${hashToken(token)} AND used_at IS NULL AND expires_at > ${new Date(now)}`;
	return row ?? null;
}

/** Atomically marks the link used. Only one caller can win, so a double-submit cannot upload twice. */
export async function claimLink(id: string, now = Date.now()): Promise<boolean> {
	const rows = await sql`UPDATE upload_links SET used_at = ${new Date(now)} WHERE id = ${id} AND used_at IS NULL AND expires_at > ${new Date(now)} RETURNING id`;
	return rows.length === 1;
}

/** Gives the link back after a failed upload so the customer can retry with the same link (until it expires). */
export async function releaseLink(id: string): Promise<void> {
	await sql`UPDATE upload_links SET used_at = NULL WHERE id = ${id}`;
}

export async function recordLinkUpload(id: string, fileName: string): Promise<void> {
	await sql`UPDATE upload_links SET uploaded_file_name = ${fileName.slice(0, 255)} WHERE id = ${id}`;
}
