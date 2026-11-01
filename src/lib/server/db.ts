/**
 * Postgres client singleton (Porsager `postgres`).
 *
 * Server-only — lives under $lib/server/ so SvelteKit refuses to bundle it
 * into the browser. DATABASE_URL comes from the runtime env (see .env.example),
 * which means the same code works in dev (Homebrew Postgres) and prod (RDS).
 *
 * Usage:
 *   import { sql } from '$lib/server/db';
 *
 *   const users = await sql<{id: string; email: string}[]>`
 *     SELECT id, email FROM users WHERE email = ${email}
 *   `;
 *
 *   await sql.begin(async (sql) => {
 *     const [acct] = await sql`INSERT INTO accounts ... RETURNING *`;
 *     await sql`INSERT INTO users (account_id, ...) VALUES (${acct.id}, ...)`;
 *   });
 */
import postgres from 'postgres';
import { env } from '$env/dynamic/private';

const DATABASE_URL = env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/samdoctor';

export const sql = postgres(DATABASE_URL, {
	max: 10,                          // pool size — adjust for prod replicas
	idle_timeout: 30,                 // close idle conns after 30s
	connect_timeout: 10,
	prepare: true,                    // server-side prepared statements
	transform: { undefined: null }    // coerce JS undefined → SQL NULL
});

/** Close the pool — call from tests/shutdown hooks. */
export async function closeDb(): Promise<void> {
	await sql.end({ timeout: 5 });
}
