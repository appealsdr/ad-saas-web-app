/**
 * Secret redaction for anything an administrator can read or that we persist
 * about administrators. Applied BEFORE storage for new writes (error_log,
 * admin audit metadata) and AGAIN before rendering legacy rows, including
 * nested JSON, messages and stack traces.
 */
const REDACTED = '[REDACTED]';

/** Object keys whose values are never shown. Matched case-insensitively as substrings. */
const SECRET_KEY_RE =
	/pass(word|wd)?|secret|token|authorization|auth_header|api[_-]?key|apikey|private[_-]?key|credential|cookie|session|jwt|signature|bearer|refresh|access[_-]?key|client[_-]?secret|otp|totp|recovery|connection[_-]?string|database[_-]?url|dsn|salt|hash/i;

/** Value patterns that look like secrets even under an innocent key. */
const VALUE_PATTERNS: Array<[RegExp, string | ((m: string, ...g: string[]) => string)]> = [
	[/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, REDACTED],
	[/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp)s?:\/\/[^\s'"]*:[^\s'"@]*@/gi, '$1://[REDACTED]@'],
	[/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
	[/\bBasic\s+[A-Za-z0-9+/=]{8,}/g, `Basic ${REDACTED}`],
	[/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED], // JWT
	[/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{8,}/g, REDACTED], // Stripe
	[/\bwhsec_[A-Za-z0-9]{8,}/g, REDACTED],
	[/\bAKIA[0-9A-Z]{16}\b/g, REDACTED], // AWS access key id
	[/\bAtza\|[A-Za-z0-9_\-|]{10,}/g, REDACTED], // Amazon LWA tokens
	[/\b(Atzr|Atza)\|[A-Za-z0-9_\-|]{10,}/g, REDACTED],
	[
		/((?:pass(?:word|wd)?|secret|token|api[_-]?key|authorization|client[_-]?secret|refresh[_-]?token|access[_-]?token)["']?\s*[:=]\s*["']?)([^\s"',;&}]+)/gi,
		(_m, p1) => `${p1}${REDACTED}`
	],
	[/([?&](?:token|key|secret|password|code|sig|signature)=)[^&\s#]+/gi, (_m, p1) => `${p1}${REDACTED}`]
];

export function redactString(input: string): string {
	let out = input;
	for (const [re, repl] of VALUE_PATTERNS) out = out.replace(re, repl as string);
	return out;
}

export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
	if (value == null) return value;
	if (typeof value === 'string') return redactString(value);
	if (typeof value !== 'object') return value;
	if (depth > 12) return '[TRUNCATED]';
	if (value instanceof Date) return value;
	if (seen.has(value as object)) return '[CIRCULAR]';
	seen.add(value as object);
	if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
		out[k] = SECRET_KEY_RE.test(k) && v != null && typeof v !== 'boolean' ? REDACTED : redactValue(v, depth + 1, seen);
	}
	return out;
}

/** Redact an object that is destined for a JSONB column. */
export function redactJson<T>(value: T): T {
	return redactValue(value) as T;
}
