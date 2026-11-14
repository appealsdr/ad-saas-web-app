/**
 * Email-verification tokens for public signups. Raw token goes in the emailed link; only its SHA-256 is stored.
 * Single-use, 24h expiry.
 */
import { randomBytes, createHash } from 'node:crypto';
import { sql } from '../db';

const TTL_SECONDS = 24 * 60 * 60;
const hashToken = (raw: string) => createHash('sha256').update(raw).digest('hex');

export async function createVerificationToken(userId: string, email: string): Promise<string> {
	const raw = randomBytes(32).toString('hex');
	await sql`
		INSERT INTO email_verification_tokens (user_id, email, token_hash, expires_at)
		VALUES (${userId}, ${email}, ${hashToken(raw)}, now() + (${TTL_SECONDS} * interval '1 second'))`;
	return raw;
}

export type ConsumeResult =
	| { ok: true; userId: string }
	| { ok: false; reason: 'invalid' | 'expired' | 'used'; userId?: string };

/** Atomically consume a token. Marks it used and clears the user's pending flag. */
export async function consumeVerificationToken(raw: string): Promise<ConsumeResult> {
	if (!/^[a-f0-9]{64}$/.test(raw)) return { ok: false, reason: 'invalid' };
	const h = hashToken(raw);
	const claimed = await sql<{ user_id: string }[]>`
		UPDATE email_verification_tokens SET used_at = now()
		WHERE token_hash = ${h} AND used_at IS NULL AND expires_at > now()
		RETURNING user_id`;
	if (claimed[0]) {
		await sql`UPDATE users SET email_verification_pending = false WHERE id = ${claimed[0].user_id}`;
		return { ok: true, userId: claimed[0].user_id };
	}
	const [row] = await sql<{ user_id: string; used_at: Date | null }[]>`
		SELECT user_id, used_at FROM email_verification_tokens WHERE token_hash = ${h} LIMIT 1`;
	if (!row) return { ok: false, reason: 'invalid' };
	return { ok: false, reason: row.used_at ? 'used' : 'expired', userId: row.user_id };
}
