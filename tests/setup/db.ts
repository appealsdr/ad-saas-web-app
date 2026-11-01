import { randomUUID } from 'node:crypto';
import { generateSecret } from 'otplib';
import { sql } from '$lib/server/db';
import { hashPassword } from '$lib/server/auth/password';
import { encryptSecret } from '$lib/server/admin/crypto';

export const hasDb = !!process.env.TEST_DB_AVAILABLE;
export const uniq = () => randomUUID().slice(0, 8);

export async function makeAccount(opts: { name?: string; onboarding?: boolean; sfdc?: string | null; email?: string | null } = {}) {
	const [a] = await sql<{ id: string; name: string }[]>`
		INSERT INTO accounts (name, email, onboarding_completed, sfdc_account_id)
		VALUES (${opts.name ?? `Acct ${uniq()}`}, ${opts.email === undefined ? `acct-${uniq()}@example.test` : opts.email},
		        ${opts.onboarding ?? true}, ${opts.sfdc ?? null})
		RETURNING id, name`;
	return a;
}

export async function makeUser(opts: { email?: string; password?: string; role?: 'owner' | 'admin' | 'member'; accountId?: string | null; active?: boolean } = {}) {
	const email = opts.email ?? `u-${uniq()}@example.test`;
	const password = opts.password ?? 'Correct-Horse-Battery-9';
	const [u] = await sql<{ id: string }[]>`
		INSERT INTO users (email, display_name, password_hash, role, account_id, is_active)
		VALUES (${email}, ${email.split('@')[0]}, ${await hashPassword(password)}, ${opts.role ?? 'member'},
		        ${opts.accountId ?? null}, ${opts.active ?? true})
		RETURNING id`;
	return { id: u.id, email, password };
}

/** A standalone platform admin (own email + password), independent of any customer user. */
export async function makeStaff(role: 'platform_admin' | 'platform_viewer', opts: { mfa?: boolean; email?: string; password?: string } = {}) {
	const email = opts.email ?? `staff-${uniq()}@example.test`;
	const password = opts.password ?? 'Correct-Horse-Battery-9';
	const [row] = await sql<{ user_id: string }[]>`
		INSERT INTO platform_staff (role, email, display_name, password_hash)
		VALUES (${role}, ${email}, ${email.split('@')[0]}, ${await hashPassword(password)}) RETURNING user_id`;
	const user = { id: row.user_id, email, password };
	let secret: string | null = null;
	if (opts.mfa !== false) {
		secret = generateSecret();
		await sql`INSERT INTO admin_mfa_credentials (user_id, secret_encrypted, confirmed_at) VALUES (${user.id}, ${encryptSecret(secret)}, now())`;
	}
	return { ...user, role, secret };
}

export async function makeStore(accountId: string, name = `Store ${uniq()}`) {
	const [s] = await sql<{ id: string }[]>`INSERT INTO stores (account_id, name) VALUES (${accountId}, ${name}) RETURNING id`;
	return s.id;
}

/** Ensure at least one OTHER active platform_admin exists so tests may demote/deactivate freely. */
export async function ensureBackupAdmin() {
	const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM platform_staff WHERE role='platform_admin' AND is_active`;
	if (r.n < 2) await makeStaff('platform_admin');
}
