/**
 * Password reuse prevention.
 *
 * Checks a candidate new password against the user's current hash and their
 * last PASSWORD_HISTORY_LIMIT previous hashes (password_history table), and
 * records the outgoing hash whenever a password is changed.
 */
import { sql } from '../db';
import { verifyPassword } from './password';

export const PASSWORD_HISTORY_LIMIT = 5;

/**
 * True if `candidate` matches the user's current password or any of their
 * last PASSWORD_HISTORY_LIMIT previous passwords.
 */
export async function isPasswordReused(userId: string, candidate: string): Promise<boolean> {
	const [current] = await sql<{ password_hash: string | null }[]>`
		SELECT password_hash FROM users WHERE id = ${userId} LIMIT 1
	`;
	if (current?.password_hash && (await verifyPassword(candidate, current.password_hash))) {
		return true;
	}

	const history = await sql<{ password_hash: string }[]>`
		SELECT password_hash FROM password_history
		WHERE user_id = ${userId}
		ORDER BY created_at DESC
		LIMIT ${PASSWORD_HISTORY_LIMIT}
	`;
	for (const row of history) {
		if (await verifyPassword(candidate, row.password_hash)) return true;
	}
	return false;
}

/**
 * Record the hash being replaced (call with the OLD password_hash, before
 * overwriting users.password_hash) and prune to the most recent
 * PASSWORD_HISTORY_LIMIT rows for that user.
 */
export async function recordPasswordHistory(userId: string, outgoingPasswordHash: string): Promise<void> {
	await sql`
		INSERT INTO password_history (user_id, password_hash)
		VALUES (${userId}, ${outgoingPasswordHash})
	`;
	await sql`
		DELETE FROM password_history
		WHERE user_id = ${userId}
		  AND id NOT IN (
		    SELECT id FROM password_history
		    WHERE user_id = ${userId}
		    ORDER BY created_at DESC
		    LIMIT ${PASSWORD_HISTORY_LIMIT}
		  )
	`;
}
