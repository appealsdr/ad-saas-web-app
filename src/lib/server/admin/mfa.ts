/**
 * TOTP MFA (RFC 6238) using the maintained `otplib` package (v13, functional API).
 *
 *  - secrets encrypted at rest (crypto.ts); never returned after enrollment is confirmed
 *  - replay protection: the accepted TOTP time step is stored and must strictly increase
 *  - recovery codes: 10 single-use codes, only SHA-256 hashes persisted
 */
import { generateSecret, generateSync, generateURI, verifySync } from 'otplib';
import QRCode from 'qrcode';
import { randomBytes } from 'node:crypto';
import { sql } from '../db';
import { decryptSecret, encryptSecret, sha256Hex } from './crypto';
import { adminIssuer } from './env';

const TOTP_TOLERANCE_SECONDS = 30; // ±1 step for clock skew

export interface MfaState {
	enrolled: boolean; // confirmed credential exists
	pending: boolean; // unconfirmed credential exists
}

export async function getMfaState(userId: string): Promise<MfaState> {
	const rows = await sql<{ confirmed_at: Date | null }[]>`
		SELECT confirmed_at FROM admin_mfa_credentials WHERE user_id = ${userId}
	`;
	const r = rows[0];
	return { enrolled: !!r?.confirmed_at, pending: !!r && !r.confirmed_at };
}

/** Return the pending (unconfirmed) enrollment if one exists, else start one. Never exposes a confirmed secret. */
export async function getOrCreateEnrollment(
	userId: string,
	email: string
): Promise<{ secret: string; uri: string; qrSvg: string }> {
	const rows = await sql<{ secret_encrypted: string; confirmed_at: Date | null }[]>`
		SELECT secret_encrypted, confirmed_at FROM admin_mfa_credentials WHERE user_id = ${userId}
	`;
	const r = rows[0];
	if (r?.confirmed_at) throw new Error('MFA is already enrolled for this user.');
	if (r) {
		const secret = decryptSecret(r.secret_encrypted);
		const uri = generateURI({ issuer: adminIssuer(), label: email, secret, strategy: 'totp' });
		return { secret, uri, qrSvg: await QRCode.toString(uri, { type: 'svg', margin: 1, width: 192 }) };
	}
	return beginEnrollment(userId, email);
}

/** Start (or restart) enrollment; returns the otpauth URI + QR SVG. Only valid before confirmation. */
export async function beginEnrollment(
	userId: string,
	email: string
): Promise<{ secret: string; uri: string; qrSvg: string }> {
	const secret = generateSecret();
	const encrypted = encryptSecret(secret);
	// Never overwrite a confirmed credential.
	const rows = await sql<{ user_id: string }[]>`
		INSERT INTO admin_mfa_credentials (user_id, secret_encrypted)
		VALUES (${userId}, ${encrypted})
		ON CONFLICT (user_id) DO UPDATE
			SET secret_encrypted = EXCLUDED.secret_encrypted, created_at = now(), last_used_step = NULL
			WHERE admin_mfa_credentials.confirmed_at IS NULL
		RETURNING user_id
	`;
	if (!rows.length) throw new Error('MFA is already enrolled for this user.');
	const uri = generateURI({ issuer: adminIssuer(), label: email, secret, strategy: 'totp' });
	const qrSvg = await QRCode.toString(uri, { type: 'svg', margin: 1, width: 192 });
	return { secret, uri, qrSvg };
}

/**
 * Verify a TOTP code. On success the time step is recorded atomically; a code
 * for a step <= last_used_step is rejected (replay). Returns false for any failure.
 */
export async function verifyTotp(userId: string, token: string, opts: { confirm?: boolean } = {}): Promise<boolean> {
	const code = token.replace(/\s+/g, '');
	if (!/^\d{6}$/.test(code)) return false;
	const rows = await sql<{ secret_encrypted: string; confirmed_at: Date | null }[]>`
		SELECT secret_encrypted, confirmed_at FROM admin_mfa_credentials WHERE user_id = ${userId}
	`;
	const cred = rows[0];
	if (!cred) return false;
	if (opts.confirm ? !!cred.confirmed_at : !cred.confirmed_at) return false;

	let secret: string;
	try {
		secret = decryptSecret(cred.secret_encrypted);
	} catch {
		return false;
	}
	const result = verifySync({ secret, token: code, strategy: 'totp', epochTolerance: TOTP_TOLERANCE_SECONDS });
	if (!result.valid) return false;
	const step = (result as { timeStep: number }).timeStep;

	const updated = await sql<{ user_id: string }[]>`
		UPDATE admin_mfa_credentials
		SET last_used_step = ${step},
		    confirmed_at = COALESCE(confirmed_at, now())
		WHERE user_id = ${userId}
		  AND (last_used_step IS NULL OR last_used_step < ${step})
		RETURNING user_id
	`;
	return updated.length === 1;
}

function normaliseRecovery(code: string): string {
	return code.replace(/[\s-]/g, '').toLowerCase();
}

export function generateRecoveryCodes(count = 10): string[] {
	return Array.from({ length: count }, () => {
		const hex = randomBytes(6).toString('hex'); // 48 bits each
		return `${hex.slice(0, 6)}-${hex.slice(6)}`;
	});
}

/** Replace all recovery codes for the user; returns the RAW codes (shown once, never stored). */
export async function issueRecoveryCodes(userId: string): Promise<string[]> {
	const codes = generateRecoveryCodes();
	await sql.begin(async (tx) => {
		await tx`DELETE FROM admin_recovery_codes WHERE user_id = ${userId}`;
		for (const c of codes) {
			await tx`
				INSERT INTO admin_recovery_codes (user_id, code_hash)
				VALUES (${userId}, ${sha256Hex(normaliseRecovery(c))})
			`;
		}
	});
	return codes;
}

/** Atomically consume a recovery code. */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
	const norm = normaliseRecovery(code);
	if (!/^[0-9a-f]{12}$/.test(norm)) return false;
	const rows = await sql<{ id: string }[]>`
		UPDATE admin_recovery_codes SET used_at = now()
		WHERE user_id = ${userId} AND code_hash = ${sha256Hex(norm)} AND used_at IS NULL
		RETURNING id
	`;
	return rows.length === 1;
}

export async function remainingRecoveryCodes(userId: string): Promise<number> {
	const [r] = await sql<{ n: number }[]>`
		SELECT count(*)::int AS n FROM admin_recovery_codes WHERE user_id = ${userId} AND used_at IS NULL
	`;
	return r.n;
}

/** Test/CLI helper: current valid code for a secret. */
export function currentTotp(secret: string): string {
	return generateSync({ secret, strategy: 'totp' });
}
