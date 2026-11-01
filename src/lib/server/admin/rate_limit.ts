/**
 * Cross-replica fixed-window rate limiter backed by admin_rate_limits.
 * Atomic single-statement upsert, so concurrent replicas share one counter.
 */
import { sql } from '../db';

export interface RateResult {
	allowed: boolean;
	count: number;
	retryAfterSeconds: number;
}

/** Increment and check. `max` attempts per `windowSeconds`. */
export async function hitRateLimit(key: string, max: number, windowSeconds: number): Promise<RateResult> {
	const [row] = await sql<{ count: number; age: number }[]>`
		INSERT INTO admin_rate_limits AS r (key, window_start, count)
		VALUES (${key}, now(), 1)
		ON CONFLICT (key) DO UPDATE SET
			window_start = CASE WHEN r.window_start < now() - (${windowSeconds} * interval '1 second')
			                    THEN now() ELSE r.window_start END,
			count        = CASE WHEN r.window_start < now() - (${windowSeconds} * interval '1 second')
			                    THEN 1 ELSE r.count + 1 END
		RETURNING count, EXTRACT(EPOCH FROM (now() - window_start))::float AS age
	`;
	return {
		allowed: row.count <= max,
		count: row.count,
		retryAfterSeconds: Math.max(1, Math.ceil(windowSeconds - row.age))
	};
}

/** Check without incrementing (e.g. before expensive password hashing). */
export async function peekRateLimit(key: string, max: number, windowSeconds: number): Promise<boolean> {
	const rows = await sql<{ count: number }[]>`
		SELECT count FROM admin_rate_limits
		WHERE key = ${key} AND window_start >= now() - (${windowSeconds} * interval '1 second')
	`;
	return (rows[0]?.count ?? 0) < max;
}

export async function resetRateLimit(key: string): Promise<void> {
	await sql`DELETE FROM admin_rate_limits WHERE key = ${key}`;
}
