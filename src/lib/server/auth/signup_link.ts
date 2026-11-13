/**
 * Salesforce-issued sign-up links (AD-1934).
 *
 * Token = base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, payloadPart))
 * Payload: { a: SF Account Id, c: SF Contact Id, k?: SF ServiceContract Id,
 *            n: nonce (single-use), e: expiry, unix seconds }
 *
 * Only Ids travel in the link; the page re-reads the live records from
 * Salesforce. Apex can mint one with Crypto.generateMac('HmacSHA256', ...) and
 * EncodingUtil.base64Encode (swap +/ for -_ and strip '='), using the same
 * SIGNUP_LINK_SECRET. See docs/signup-link.md.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';

export interface SignupLinkPayload {
	sfdcAccountId: string;
	sfdcContactId: string;
	sfdcServiceContractId: string | null;
	nonce: string;
	expiresAt: number;
}

const SF_ID_RE = /^[a-zA-Z0-9]{15}([a-zA-Z0-9]{3})?$/;

function sign(part: string, secret: string): Buffer {
	return createHmac('sha256', secret).update(part).digest();
}

export function createSignupToken(
	input: { sfdcAccountId: string; sfdcContactId: string; sfdcServiceContractId?: string | null; ttlSeconds?: number },
	secret = env.SIGNUP_LINK_SECRET ?? ''
): string {
	if (!secret) throw new Error('SIGNUP_LINK_SECRET is not set');
	const body = {
		a: input.sfdcAccountId,
		c: input.sfdcContactId,
		k: input.sfdcServiceContractId ?? undefined,
		n: randomBytes(12).toString('base64url'),
		e: Math.floor(Date.now() / 1000) + (input.ttlSeconds ?? 14 * 24 * 3600)
	};
	const part = Buffer.from(JSON.stringify(body)).toString('base64url');
	return `${part}.${sign(part, secret).toString('base64url')}`;
}

export type VerifyResult =
	| { ok: true; payload: SignupLinkPayload }
	| { ok: false; reason: 'invalid' | 'expired' | 'not_configured' };

export function verifySignupToken(
	token: string | null | undefined,
	secret = env.SIGNUP_LINK_SECRET ?? ''
): VerifyResult {
	if (!secret) return { ok: false, reason: 'not_configured' };
	const [part, sig, extra] = String(token ?? '').split('.');
	if (!part || !sig || extra !== undefined) return { ok: false, reason: 'invalid' };
	const given = Buffer.from(sig, 'base64url');
	const expected = sign(part, secret);
	if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
		return { ok: false, reason: 'invalid' };
	}
	try {
		const b = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
		if (!SF_ID_RE.test(b.a) || !SF_ID_RE.test(b.c) || (b.k != null && !SF_ID_RE.test(b.k)) || typeof b.n !== 'string' || typeof b.e !== 'number') {
			return { ok: false, reason: 'invalid' };
		}
		if (b.e < Date.now() / 1000) return { ok: false, reason: 'expired' };
		return {
			ok: true,
			payload: { sfdcAccountId: b.a, sfdcContactId: b.c, sfdcServiceContractId: b.k ?? null, nonce: b.n, expiresAt: b.e }
		};
	} catch {
		return { ok: false, reason: 'invalid' };
	}
}
