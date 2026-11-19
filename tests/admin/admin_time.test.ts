import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, isValidTimeZone, periodBounds, relativeTime, resolveTimeZone, toDate, zonedMidnightUtc } from '../../src/lib/admin/time';
import { fillTrend, parseUsageQuery } from '../../src/lib/server/admin/usage';

describe('admin time zone helper', () => {
	it('validates IANA names and resolves saved → browser → UTC', () => {
		expect(isValidTimeZone('America/New_York')).toBe(true);
		expect(isValidTimeZone('Not/AZone')).toBe(false);
		expect(isValidTimeZone('')).toBe(false);
		expect(resolveTimeZone('Asia/Tokyo')).toBe('Asia/Tokyo');
		expect(isValidTimeZone(resolveTimeZone('garbage'))).toBe(true); // falls back to the runtime zone or UTC
	});

	it('converts a UTC instant for display with the zone abbreviation, leaving the value untouched', () => {
		const iso = '2026-11-19T03:29:00Z';
		expect(formatDateTime(iso, 'America/New_York')).toBe('Nov 18, 2026 10:29 PM EST');
		expect(formatDateTime(iso, 'UTC')).toBe('Nov 19, 2026 3:29 AM UTC');
		expect(formatDateTime(iso, 'Asia/Tokyo')).toContain('12:29 PM');
		expect(iso).toBe('2026-11-19T03:29:00Z'); // display only — nothing stored changes
	});

	it('handles daylight saving (EST in winter, EDT in summer)', () => {
		expect(formatDateTime('2026-01-15T17:00:00Z', 'America/New_York')).toContain('EST');
		expect(formatDateTime('2026-07-15T16:00:00Z', 'America/New_York')).toContain('EDT');
		expect(formatDateTime('2026-07-15T16:00:00Z', 'America/New_York')).toContain('12:00 PM');
		// spring-forward day: 2026-03-08 02:00 local does not exist; UTC-5 → UTC-4
		expect(formatDateTime('2026-03-08T06:59:00Z', 'America/New_York')).toContain('1:59 AM EST');
		expect(formatDateTime('2026-03-08T07:00:00Z', 'America/New_York')).toContain('3:00 AM EDT');
	});

	it('parses the app\'s "YYYY-MM-DD HH:mm:ss UTC" display strings and leaves bare dates unshifted', () => {
		expect(toDate('2026-11-19 03:29:00 UTC')?.toISOString()).toBe('2026-11-19T03:29:00.000Z');
		expect(formatDateTime('2026-11-19 03:29:00 UTC', 'America/New_York')).toContain('10:29 PM');
		expect(formatDate('2026-11-18', 'Pacific/Kiritimati')).toBe('Nov 18, 2026'); // a calendar date never moves
		expect(formatDateTime(null, 'UTC')).toBe('—');
		expect(formatDateTime('nonsense', 'UTC')).toBe('—');
	});

	it('formats relative time', () => {
		const now = Date.parse('2026-11-18T12:00:00Z');
		expect(relativeTime('2026-11-18T11:59:50Z', now)).toBe('just now');
		expect(relativeTime('2026-11-18T09:00:00Z', now)).toBe('3 hours ago');
		expect(relativeTime('2026-11-17T12:00:00Z', now)).toBe('1 day ago');
		expect(relativeTime(null, now)).toBe('No activity');
	});
});

describe('period bounds in the admin time zone', () => {
	const now = new Date('2026-11-19T03:29:00Z'); // still Nov 18 evening in New York
	it('"Today" is the admin\'s local day, not the UTC day', () => {
		const ny = periodBounds('today', 'America/New_York', now);
		expect(ny.start.toISOString()).toBe('2026-11-18T05:00:00.000Z');
		expect(ny.end.toISOString()).toBe('2026-11-19T05:00:00.000Z');
		const utc = periodBounds('today', 'UTC', now);
		expect(utc.start.toISOString()).toBe('2026-11-19T00:00:00.000Z');
	});
	it('week starts Monday and month starts on the 1st (local)', () => {
		const wk = periodBounds('week', 'America/New_York', now); // Wed Nov 18 2026
		expect(wk.start.toISOString()).toBe('2026-11-16T05:00:00.000Z');
		expect(wk.days).toHaveLength(7);
		const mo = periodBounds('month', 'America/New_York', now);
		expect(mo.start.toISOString()).toBe('2026-11-01T04:00:00.000Z'); // still EDT on Nov 1 (DST ends Nov 1 at 2am)
		expect(mo.days).toHaveLength(30);
	});
	it('a DST day is 23/25 hours long, not 24', () => {
		const start = zonedMidnightUtc(2026, 3, 8, 'America/New_York');
		const end = zonedMidnightUtc(2026, 3, 9, 'America/New_York');
		expect((end.getTime() - start.getTime()) / 3600000).toBe(23);
	});
});

describe('usage dashboard pure helpers', () => {
	it('fills gaps so the chart has one point per bucket', () => {
		expect(fillTrend(['2026-11-16', '2026-11-17', '2026-11-18'], [{ k: '2026-11-17', users: 4 }])).toEqual([
			{ label: '2026-11-16', users: 0 }, { label: '2026-11-17', users: 4 }, { label: '2026-11-18', users: 0 }
		]);
	});
	it('parses the query safely', () => {
		expect(parseUsageQuery(new URLSearchParams('period=week&staff=1'), 'UTC')).toMatchObject({ period: 'week', includeStaff: true });
		expect(parseUsageQuery(new URLSearchParams('period=bogus'), 'Bad/Zone')).toMatchObject({ period: 'today', tz: 'UTC', includeStaff: false });
	});
});
