import { describe, it, expect } from 'vitest';
import {
	validateFullName, validateCompanyName, validateEmail, canonicalEmailKey, validatePhone, validateWebsite, looksLikeBot
} from '../../src/lib/server/auth/signup_validation';

// Real examples from the AD-1946 spam export.
const SPAM_NAMES = ['gbhbzISWZIPjOcQHXyg', 'gIeNoIDfpnZoArBzrtLUmWvm', 'LcmkMwWwQidxplQJljyFT', 'iYBDJNVpBRiQErIDWguFzk'];
const SPAM_EMAILS = ['t.ece.v.ekaf.a.xi5.6@gmail.com', 'amojo.ba.g.o.h.i.c.4.6@gmail.com', 'a.gi.va.y.o.co.y9.3.0@gmail.com'];
// Caught by the shape heuristic; others from the export (e.g. zbovoztchupl.com) are caught by the DNS check instead.
const SPAM_SITES = ['https://zgqjzzjorjqp.com', 'https://hqqdmdigvos.com', 'https://rwnltvuzpvaz.com'];

describe('full name', () => {
	it('rejects the random single-token names', () => {
		for (const n of SPAM_NAMES) expect(validateFullName(n), n).not.toBeNull();
	});
	it('requires first and last name', () => {
		expect(validateFullName('Juan')).not.toBeNull();
		expect(validateFullName('')).not.toBeNull();
	});
	it('rejects random two-word names and bad characters', () => {
		expect(validateFullName('gIeNoIDfpnZoArBz xWYwEplsaNtugx')).not.toBeNull();
		expect(validateFullName('John <script>')).not.toBeNull();
		expect(validateFullName('John 123 Smith')).not.toBeNull();
	});
	it('accepts legitimate names', () => {
		for (const n of ['Juan Velasco', 'Mary-Jane O’Connor', "Patrick O'Brien", 'Ana María de la Cruz', 'Jean-Luc Picard', 'Ngoc Nguyen', 'Brian McDonald', 'DeShawn Washington', 'Hirschfeld Schwartz', 'José Núñez', 'Li Wei', 'Strzelczyk Anna'])
			expect(validateFullName(n), n).toBeNull();
	});
});

describe('company', () => {
	it('accepts normal companies', () => {
		for (const c of ['Acme LLC', 'A-Z Claims', 'Smith & Sons Inc.', '3M', 'Hirschfeld Brands LLC', 'Bright Home Goods']) expect(validateCompanyName(c), c).toBeNull();
	});
	it('rejects empty, urls and random strings', () => {
		expect(validateCompanyName('x')).not.toBeNull();
		expect(validateCompanyName('http://spam.com')).not.toBeNull();
		expect(validateCompanyName('gIeNoIDfpnZoArBzrtLUmWvm LLC')).not.toBeNull();
	});
});

describe('email', () => {
	it('rejects the dotted-gmail spam addresses', () => {
		for (const e of SPAM_EMAILS) expect(validateEmail(e), e).not.toBeNull();
	});
	it('rejects disposable domains and malformed addresses', () => {
		expect(validateEmail('a@mailinator.com')).not.toBeNull();
		expect(validateEmail('a@@b.com')).not.toBeNull();
		expect(validateEmail('a@b')).not.toBeNull();
		expect(validateEmail('a..b@c.com')).not.toBeNull();
		expect(validateEmail('x@y.c0m')).not.toBeNull();
		expect(validateEmail('a@b.test', ['b.test'])).not.toBeNull();
	});
	it('accepts normal addresses, including a couple of gmail dots and +tags', () => {
		for (const e of ['sam@acme.com', 'first.last@gmail.com', 'a.b.c@gmail.com', 'sam+claims@acme.co.uk']) expect(validateEmail(e), e).toBeNull();
	});
	it('canonicalizes gmail so dot/plus variants collide', () => {
		expect(canonicalEmailKey('A.b.C+x@Gmail.com')).toBe('abc@gmail.com');
		expect(canonicalEmailKey('abc@googlemail.com')).toBe('abc@gmail.com');
		expect(canonicalEmailKey('a.b@acme.com')).toBe('a.b@acme.com');
	});
});

describe('phone', () => {
	it('accepts valid numbers and normalizes to E.164', () => {
		expect(validatePhone('(415) 411-4111')).toEqual({ ok: true, e164: '+14154114111' });
		expect(validatePhone('+44 20 7946 0958')).toMatchObject({ ok: true });
	});
	it('rejects fakes and garbage', () => {
		for (const p of ['5555555555', '1234567890', '1111111111', '123', 'abcdefghij', '+1 000 000 0000']) expect(validatePhone(p).ok, p).toBe(false);
	});
});

describe('website', () => {
	it('rejects random domains and placeholders', () => {
		for (const w of SPAM_SITES) expect(validateWebsite(w), w).not.toBeNull();
		expect(validateWebsite('localhost')).not.toBeNull();
		expect(validateWebsite('example.com')).not.toBeNull();
		expect(validateWebsite('not a url')).not.toBeNull();
	});
	it('accepts real-looking sites', () => {
		for (const w of ['acme.com', 'https://www.brightgoods.co', 'http://shop.my-store.io/path', 'strengthsandstrings.com']) expect(validateWebsite(w), w).toBeNull();
	});
});

describe('bot signals', () => {
	const now = 1_000_000_000_000;
	it('flags honeypot, missing/too-fast/stale timestamps', () => {
		expect(looksLikeBot({ honeypot: 'x', startedAt: String(now - 10_000), now })).toBe(true);
		expect(looksLikeBot({ honeypot: '', startedAt: '', now })).toBe(true);
		expect(looksLikeBot({ honeypot: '', startedAt: String(now - 500), now })).toBe(true);
		expect(looksLikeBot({ honeypot: '', startedAt: String(now - 2 * 86400_000), now })).toBe(true);
	});
	it('passes a human-paced submission', () => {
		expect(looksLikeBot({ honeypot: '', startedAt: String(now - 20_000), now })).toBe(false);
	});
});
