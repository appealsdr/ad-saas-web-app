/**
 * Password hashing using Node's built-in scrypt (no external deps).
 *
 * Stored format: `scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>`
 *   - N=16384 (2^14), r=8, p=1 — sensible 2020s defaults from RFC 7914.
 *   - 16-byte random salt, 64-byte derived key.
 *
 * Verify always derives with the parameters embedded in the stored string,
 * so we can bump cost factors later without breaking old hashes.
 *
 * Comparison uses timingSafeEqual to defeat timing side-channels.
 */
import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/** scrypt with options, wrapped as a Promise — promisify's typings drop the options overload. */
function scryptAsync(
	password: string,
	salt: Buffer,
	keylen: number,
	options: ScryptOptions
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scrypt(password, salt, keylen, options, (err, derivedKey) => {
			if (err) reject(err);
			else resolve(derivedKey);
		});
	});
}

const N = 16384;          // CPU/memory cost
const R = 8;              // block size
const P = 1;              // parallelization
const SALT_BYTES = 16;
const KEY_BYTES = 64;

export async function hashPassword(password: string): Promise<string> {
	if (!password) throw new Error('hashPassword: empty password');
	const salt = randomBytes(SALT_BYTES);
	const derived = await scryptAsync(password, salt, KEY_BYTES, { N, r: R, p: P });
	return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	if (!password || !stored) return false;
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

	const N_ = Number(parts[1]);
	const r_ = Number(parts[2]);
	const p_ = Number(parts[3]);
	const salt = Buffer.from(parts[4], 'hex');
	const expected = Buffer.from(parts[5], 'hex');

	if (!Number.isFinite(N_) || !Number.isFinite(r_) || !Number.isFinite(p_)) return false;
	if (salt.length !== SALT_BYTES || expected.length === 0) return false;

	let derived: Buffer;
	try {
		derived = await scryptAsync(password, salt, expected.length, {
			N: N_,
			r: r_,
			p: p_
		});
	} catch {
		return false;
	}
	if (derived.length !== expected.length) return false;
	return timingSafeEqual(derived, expected);
}
