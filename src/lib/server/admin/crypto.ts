/**
 * Small crypto helpers for the admin area: opaque tokens, SHA-256 hashing and
 * AES-256-GCM encryption of TOTP secrets.
 *
 * ADMIN_MFA_ENCRYPTION_KEY       current key, 32 bytes as base64 or 64 hex chars.
 * ADMIN_MFA_ENCRYPTION_KEY_PREVIOUS   optional old key, decrypt-only (rotation).
 *
 * Ciphertext format: `v1.<keyId>.<iv>.<tag>.<ciphertext>` (base64url parts).
 * keyId = first 8 hex chars of SHA-256(key) so decrypt picks the right key.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { adminEnv } from './env';

export function newOpaqueToken(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(input: string): string {
	return createHash('sha256').update(input).digest('hex');
}

function parseKey(raw: string | undefined): Buffer | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	let key: Buffer | null = null;
	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) key = Buffer.from(trimmed, 'hex');
	else {
		const b = Buffer.from(trimmed, 'base64');
		if (b.length === 32) key = b;
	}
	return key;
}

function keyId(key: Buffer): string {
	return createHash('sha256').update(key).digest('hex').slice(0, 8);
}

function keyring(): { current: Buffer | null; all: Map<string, Buffer> } {
	const current = parseKey(adminEnv('ADMIN_MFA_ENCRYPTION_KEY'));
	const previous = parseKey(adminEnv('ADMIN_MFA_ENCRYPTION_KEY_PREVIOUS'));
	const all = new Map<string, Buffer>();
	if (current) all.set(keyId(current), current);
	if (previous) all.set(keyId(previous), previous);
	return { current, all };
}

export class MfaKeyMissingError extends Error {
	constructor() {
		super('ADMIN_MFA_ENCRYPTION_KEY is not configured (need 32 bytes as base64 or 64 hex chars).');
	}
}

export function encryptSecret(plaintext: string): string {
	const { current } = keyring();
	if (!current) throw new MfaKeyMissingError();
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', current, iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return ['v1', keyId(current), iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(payload: string): string {
	const parts = payload.split('.');
	if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Unrecognised ciphertext format');
	const { all } = keyring();
	const key = all.get(parts[1]);
	if (!key) throw new MfaKeyMissingError();
	const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(parts[2], 'base64url'));
	decipher.setAuthTag(Buffer.from(parts[3], 'base64url'));
	return Buffer.concat([decipher.update(Buffer.from(parts[4], 'base64url')), decipher.final()]).toString('utf8');
}

/** Re-encrypt under the current key (used by the key-rotation CLI command). */
export function reencryptSecret(payload: string): string {
	return encryptSecret(decryptSecret(payload));
}
