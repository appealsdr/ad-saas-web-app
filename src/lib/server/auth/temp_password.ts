/** One-time temporary passwords issued at provisioning or on a forced reset. */
import { randomBytes } from 'node:crypto';

/** e.g. "kx7m-htq2-vw9j" — 12 random base32-ish chars, easy to read/type once. */
export function generateTempPassword(): string {
	const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o/1/l/i ambiguity
	const bytes = randomBytes(12);
	let out = '';
	for (let i = 0; i < bytes.length; i++) {
		if (i > 0 && i % 4 === 0) out += '-';
		out += alphabet[bytes[i] % alphabet.length];
	}
	return out;
}
