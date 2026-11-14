/**
 * Signup validation + abuse heuristics (pure, no I/O — unit-tested in tests/unit/signup-validation.test.ts).
 *
 * Context (AD-1946): the public /register form was being filled by a bot — single random-string names
 * ("gIeNoIDfpnZoArBzrtLUmWvm"), "<random> LLC" companies, random .com websites, random phone numbers and
 * Gmail addresses with random dots. Each check returns an error message for the user, or null when OK.
 * Heuristics are deliberately lenient: a false reject costs a real customer, a miss is caught by
 * Turnstile / rate limiting / email verification.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/max';

export type Check = string | null;

const VOWELS = /[aeiouy]/i;

/** Longest run of consonants (y counts as a vowel) in a lowercase letters-only string. */
function maxConsonantRun(s: string): number {
	let run = 0;
	let best = 0;
	for (const ch of s.toLowerCase()) {
		if (/[a-z]/.test(ch) && !VOWELS.test(ch)) {
			run++;
			best = Math.max(best, run);
		} else run = 0;
	}
	return best;
}

/** Number of lower→UPPER transitions inside a token ("gIeNoIDf" = 4, "McDonald" = 1, "DeAndre" = 1). */
function caseFlips(token: string): number {
	let n = 0;
	for (let i = 1; i < token.length; i++) if (/[a-z]/.test(token[i - 1]) && /[A-Z]/.test(token[i])) n++;
	return n;
}

/** True when a single word looks like keyboard-mash / random characters rather than a real word or name. */
export function looksRandom(token: string, opts: { maxRun: number; maxLen?: number }): boolean {
	const letters = token.replace(/[^A-Za-z]/g, '');
	if (letters.length < 5) return false;
	if (caseFlips(token) >= 2) return true; // gIeNoIDf… (real names rarely flip case twice: McDonald=1, DeShawn=1)
	if (!VOWELS.test(letters)) return true; // "bcdfgh"
	if (maxConsonantRun(letters) >= opts.maxRun) return true; // "gbhbzISW…"
	if (opts.maxLen !== undefined && letters.length >= opts.maxLen && !token.includes('-')) return true; // e.g. a single 14+ letter word as a name
	return false;
}

// ─── Name ──────────────────────────────────────────────────────────────

const NAME_CHARS = /^[\p{L}][\p{L}\p{M} .'’-]*$/u;

export function validateFullName(raw: string): Check {
	const name = raw.trim().replace(/\s+/g, ' ');
	if (name.length < 3 || name.length > 80) return 'Please enter your first and last name.';
	if (!NAME_CHARS.test(name)) return 'Your name can only contain letters, spaces, hyphens and apostrophes.';
	const parts = name.split(' ').filter((p) => p.replace(/[.]/g, '').length > 0);
	if (parts.length < 2) return 'Please enter both your first and last name.';
	if (parts.some((p) => p.replace(/[^\p{L}]/gu, '').length < 1)) return 'Please enter your first and last name.';
	if (parts.some((p) => looksRandom(p, { maxRun: 6, maxLen: 14 }))) return 'Please enter your real first and last name.';
	return null;
}

// ─── Company ───────────────────────────────────────────────────────────

export function validateCompanyName(raw: string): Check {
	const company = raw.trim().replace(/\s+/g, ' ');
	if (company.length < 2 || company.length > 100) return 'Please enter your company name (2–100 characters).';
	if (!/[\p{L}\p{N}]/u.test(company)) return 'Please enter a valid company name.';
	if (/[<>{}\\]/.test(company) || /https?:\/\//i.test(company)) return 'Company name contains invalid characters.';
	const words = company.split(' ').filter((w) => !/^(llc|inc|ltd|co|corp|l\.l\.c\.|inc\.)$/i.test(w.replace(/[,.]/g, '')));
	if (words.some((w) => looksRandom(w, { maxRun: 6, maxLen: 20 }))) return 'Please enter your real company name.';
	return null;
}

// ─── Email ─────────────────────────────────────────────────────────────

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Disposable / throwaway providers (non-exhaustive; extend via SIGNUP_BLOCKED_EMAIL_DOMAINS, comma-separated). */
const DISPOSABLE_DOMAINS = new Set([
	'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la', '10minutemail.com',
	'10minutemail.net', 'tempmail.com', 'temp-mail.org', 'temp-mail.io', 'tempmail.net', 'throwawaymail.com',
	'yopmail.com', 'yopmail.net', 'trashmail.com', 'getnada.com', 'nada.email', 'maildrop.cc', 'dispostable.com',
	'fakeinbox.com', 'mailnesia.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'spamgourmet.com',
	'burnermail.io', 'moakt.com', 'tmpmail.org', 'tmpmail.net', 'mail.tm', 'dropmail.me', 'anonaddy.me',
	'mytemp.email', 'inboxkitten.com', 'tempinbox.com', 'discard.email', 'cuvox.de', 'armyspy.com', 'dayrep.com'
]);

export interface EmailParts { local: string; domain: string }

export function splitEmail(email: string): EmailParts | null {
	const at = email.lastIndexOf('@');
	if (at < 1 || at === email.length - 1) return null;
	return { local: email.slice(0, at), domain: email.slice(at + 1) };
}

/**
 * Canonical mailbox key: for Gmail strip dots and "+tag" so the dot trick (a.b.c@gmail.com = abc@gmail.com)
 * can't create unlimited "different" users. Other providers only lose "+tag"-insensitive casing.
 */
export function canonicalEmailKey(email: string): string {
	const e = email.trim().toLowerCase();
	const p = splitEmail(e);
	if (!p) return e;
	if (GMAIL_DOMAINS.has(p.domain)) return `${p.local.split('+')[0].replace(/\./g, '')}@gmail.com`;
	return e;
}

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function validateEmail(raw: string, extraBlocked: string[] = []): Check {
	const email = raw.trim().toLowerCase();
	if (email.length > 254 || !EMAIL_RE.test(email)) return 'Please enter a valid email address.';
	const p = splitEmail(email)!;
	if (p.local.length > 64 || p.local.includes('..') || p.local.startsWith('.') || p.local.endsWith('.')) {
		return 'Please enter a valid email address.';
	}
	const tld = p.domain.split('.').pop() ?? '';
	if (!/^[a-z]{2,24}$/.test(tld)) return 'Please enter a valid email address.';
	const blocked = new Set([...DISPOSABLE_DOMAINS, ...extraBlocked.map((d) => d.trim().toLowerCase()).filter(Boolean)]);
	if (blocked.has(p.domain)) return 'Please use a permanent business email address — disposable email providers are not accepted.';
	// Real Gmail users almost never have 4+ dots in the local part; the bot signups had 4–7.
	if (GMAIL_DOMAINS.has(p.domain) && (p.local.split('+')[0].match(/\./g)?.length ?? 0) >= 4) {
		return 'Please enter a valid email address.';
	}
	return null;
}

// ─── Phone ─────────────────────────────────────────────────────────────

/** Returns the normalized E.164 phone on success, or an error string. Default region US for national numbers. */
export function validatePhone(raw: string, defaultCountry: CountryCode = 'US'): { ok: true; e164: string } | { ok: false; error: string } {
	const invalid = { ok: false as const, error: 'Please enter a valid phone number (include the country code if outside the US).' };
	const phone = raw.trim();
	if (!phone || phone.length > 30) return invalid;
	const parsed = parsePhoneNumberFromString(phone, defaultCountry);
	if (!parsed || !parsed.isValid()) return invalid;
	const national = parsed.nationalNumber.toString();
	// Obvious fakes: all one digit (5555555555), or a straight sequence (1234567890).
	if (/^(\d)\1+$/.test(national) || '01234567890123456789'.includes(national) || '98765432109876543210'.includes(national)) return invalid;
	return { ok: true, e164: parsed.number };
}

// ─── Website ───────────────────────────────────────────────────────────

/** Returns the normalized https URL host check; error string when invalid / random-looking. */
export function validateWebsite(raw: string): Check {
	const input = raw.trim();
	if (input.length > 253) return 'Please enter a valid website (e.g. acme.com or https://acme.com).';
	let host: string;
	try {
		host = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`).hostname.toLowerCase();
	} catch {
		return 'Please enter a valid website (e.g. acme.com or https://acme.com).';
	}
	const labels = host.replace(/^www\./, '').split('.');
	const tld = labels[labels.length - 1];
	if (labels.length < 2 || !/^[a-z]{2,24}$/.test(tld) || labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) {
		return 'Please enter a valid website (e.g. acme.com or https://acme.com).';
	}
	if (['localhost', 'example.com', 'example.org', 'test.com', 'domain.com'].includes(labels.slice(-2).join('.'))) {
		return 'Please enter your real company website.';
	}
	const sld = labels[labels.length - 2];
	if (looksRandom(sld, { maxRun: 6 }) && !sld.includes('-')) return 'Please enter your real company website.';
	return null;
}

// ─── Bot signals ───────────────────────────────────────────────────────

export const MIN_FILL_MS = 3_000;
export const MAX_FILL_MS = 24 * 60 * 60 * 1000;

/**
 * `startedAt` is stamped client-side when the form mounts (a bot that POSTs directly never sets it) and
 * `honeypot` is a field real users can't see. Returns true when the submission is bot-like.
 */
export function looksLikeBot(input: { honeypot: string; startedAt: string; now?: number }): boolean {
	if (input.honeypot.trim() !== '') return true;
	const started = Number(input.startedAt);
	if (!Number.isFinite(started) || started <= 0) return true;
	const elapsed = (input.now ?? Date.now()) - started;
	return elapsed < MIN_FILL_MS || elapsed > MAX_FILL_MS;
}
