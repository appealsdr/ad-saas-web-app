/**
 * Shared admin date/time helpers (AD-1954). Everything is stored and transported in UTC; these functions only
 * convert for DISPLAY, using Intl (so DST is handled by the platform, never by hand-written offsets).
 *
 * Time zone resolution: the admin's saved IANA zone → the browser's zone → UTC.
 */
export type DateInput = Date | string | number | null | undefined;

export function isValidTimeZone(tz: string | null | undefined): tz is string {
	if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

export function browserTimeZone(): string | null {
	try {
		const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
		return isValidTimeZone(tz) ? tz : null;
	} catch {
		return null;
	}
}

/** Saved zone if valid, else the browser's zone, else UTC. */
export function resolveTimeZone(saved?: string | null): string {
	return isValidTimeZone(saved) ? saved : browserTimeZone() ?? 'UTC';
}

/** All selectable IANA zones (falls back to a short list on runtimes without Intl.supportedValuesOf). */
export function listTimeZones(): string[] {
	try {
		const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
		const all = fn ? fn('timeZone') : [];
		if (all.length) return all.includes('UTC') ? all : ['UTC', ...all];
	} catch { /* fall through */ }
	return ['UTC', 'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Berlin', 'Asia/Jerusalem', 'Asia/Kolkata', 'Asia/Tokyo', 'Australia/Sydney'];
}

const UTC_DISPLAY = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?\s*(?:UTC|Z)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a Date, epoch, ISO string, or the app's "YYYY-MM-DD HH:mm[:ss] UTC" display string. Invalid → null. */
export function toDate(v: DateInput): Date | null {
	if (v === null || v === undefined || v === '') return null;
	if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
	if (typeof v === 'number') return isNaN(v) ? null : new Date(v);
	const s = String(v).trim();
	if (DATE_ONLY.test(s)) return null; // calendar dates carry no time → handled by formatDate, never shifted
	const m = UTC_DISPLAY.exec(s);
	const d = new Date(m ? `${m[1]}T${m[2].length === 5 ? m[2] + ':00' : m[2]}Z` : s);
	return isNaN(d.getTime()) ? null : d;
}

/** e.g. "Nov 18, 2026, 10:29 PM EST" — the abbreviation is included because it disambiguates DST. */
export function formatDateTime(v: DateInput, tz: string, o: { seconds?: boolean; abbr?: boolean } = {}): string {
	const d = toDate(v);
	if (!d) return typeof v === 'string' && DATE_ONLY.test(v.trim()) ? formatDate(v, tz) : '—';
	try {
		return new Intl.DateTimeFormat('en-US', {
			timeZone: tz, year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
			...(o.seconds ? { second: '2-digit' } : {}), ...(o.abbr === false ? {} : { timeZoneName: 'short' })
		}).format(d).replace(/,\s(\d{1,2}:)/, ' $1');
	} catch {
		return d.toISOString();
	}
}

/** Date only. A bare calendar date ("2026-11-18") is shown as-is (it has no instant to convert). */
export function formatDate(v: DateInput, tz: string): string {
	if (typeof v === 'string' && DATE_ONLY.test(v.trim())) {
		const [y, m, d] = v.trim().split('-').map(Number);
		return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
	}
	const d = toDate(v);
	if (!d) return '—';
	try { return new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'short', day: 'numeric' }).format(d); } catch { return d.toISOString().slice(0, 10); }
}

/** "3 hours ago" style text; null/invalid → "No activity". */
export function relativeTime(v: DateInput, now: number = Date.now()): string {
	const d = toDate(v);
	if (!d) return 'No activity';
	const s = Math.round((now - d.getTime()) / 1000);
	if (s < 45) return 'just now';
	const units: [number, string][] = [[60, 'minute'], [3600, 'hour'], [86400, 'day'], [2592000, 'month'], [31536000, 'year']];
	let value = Math.round(s / 60), unit = 'minute';
	for (const [secs, name] of units) if (s >= secs) { value = Math.round(s / secs); unit = name; }
	if (unit === 'month' && value >= 12) { value = 1; unit = 'year'; }
	return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(at: number, tz: string): number {
	const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
		.formatToParts(new Date(at)).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** The UTC instant of 00:00 on local calendar day y-m-d in `tz` (DST-safe: re-checks the offset at the result). */
export function zonedMidnightUtc(y: number, m: number, d: number, tz: string): Date {
	const guess = Date.UTC(y, m - 1, d);
	let t = guess - tzOffsetMs(guess, tz);
	t = guess - tzOffsetMs(t, tz);
	return new Date(t);
}

export type Period = 'today' | 'week' | 'month';
export const PERIODS: Period[] = ['today', 'week', 'month'];

/** [start, end) of Today / This Week (Monday start) / This Month in `tz`, as UTC instants. */
export function periodBounds(period: Period, tz: string, now: Date = new Date()): { start: Date; end: Date; days: string[] } {
	const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(now).filter((x) => x.type !== 'literal').map((x) => [x.type, Number(x.value)]));
	let { year: y, month: m, day: d } = parts as { year: number; month: number; day: number };
	const cal = (yy: number, mm: number, dd: number) => new Date(Date.UTC(yy, mm - 1, dd));
	let startCal = cal(y, m, d);
	let endCal = cal(y, m, d + 1);
	if (period === 'week') {
		const dow = (startCal.getUTCDay() + 6) % 7; // Monday = 0
		startCal = cal(y, m, d - dow);
		endCal = cal(y, m, d - dow + 7);
	} else if (period === 'month') {
		startCal = cal(y, m, 1);
		endCal = cal(y, m + 1, 1);
	}
	const days: string[] = [];
	for (let t = startCal.getTime(); t < endCal.getTime(); t += 86400000) days.push(new Date(t).toISOString().slice(0, 10));
	const at = (c: Date) => zonedMidnightUtc(c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate(), tz);
	return { start: at(startCal), end: at(endCal), days };
}
