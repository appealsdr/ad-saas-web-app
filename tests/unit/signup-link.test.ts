import { describe, it, expect, vi } from 'vitest';
vi.mock('$env/dynamic/private', () => ({ env: {} }));
import { createSignupToken, verifySignupToken } from '../../src/lib/server/auth/signup_link';

const S = 'test-secret';
const A = '001000000000001AAA';
const C = '003000000000001AAA';

describe('signup link', () => {
	it('round-trips', () => {
		const t = createSignupToken({ sfdcAccountId: A, sfdcContactId: C, sfdcServiceContractId: '810000000000001AAA' }, S);
		const r = verifySignupToken(t, S);
		expect(r.ok && r.payload.sfdcAccountId).toBe(A);
	});
	it('rejects tampering, wrong secret, expiry', () => {
		const t = createSignupToken({ sfdcAccountId: A, sfdcContactId: C }, S);
		expect(verifySignupToken(t, 'other').ok).toBe(false);
		expect(verifySignupToken('x' + t, S).ok).toBe(false);
		const old = createSignupToken({ sfdcAccountId: A, sfdcContactId: C, ttlSeconds: -10 }, S);
		expect(verifySignupToken(old, S)).toEqual({ ok: false, reason: 'expired' });
	});
});
