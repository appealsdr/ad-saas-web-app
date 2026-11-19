/**
 * Admin usage dashboard (AD-1954): aggregates over activity_log — the same source as the per-account "App activity"
 * tab (login / page_view / page_time / click / action events, all stored in UTC).
 *
 * Periods (Today / This Week / This Month) are calendar periods in the ADMIN's time zone; their [start, end) bounds
 * are converted to UTC instants once (see periodBounds) and every query filters on those instants.
 * By default, impersonated/read-only staff sessions are excluded so admins' own browsing never skews the numbers.
 */
import { sql } from '../db';
import { isValidTimeZone, periodBounds, type Period, PERIODS } from '../../admin/time';

export interface UsageQuery { period: Period; tz: string; includeStaff: boolean }

export function parseUsageQuery(p: URLSearchParams, tz: string): UsageQuery {
	const period = PERIODS.find((x) => x === p.get('period')) ?? 'today';
	return { period, tz: isValidTimeZone(tz) ? tz : 'UTC', includeStaff: p.get('staff') === '1' };
}

export interface UsageResult {
	period: Period; tz: string; includeStaff: boolean;
	range: { start: string; end: string };
	totals: { activeUsers: number; logins: number; sessions: number; pageViews: number };
	topTime: { path: string; totalMs: number; avgMs: number; visits: number }[];
	topViews: { path: string; views: number; users: number }[];
	trend: { label: string; users: number }[];
	trendUnit: 'hour' | 'day';
	topAccounts: { id: string; name: string; events: number; users: number }[];
	topUsers: { id: string; email: string; name: string | null; account: string | null; events: number }[];
}

/** Fill gaps so the chart always has one point per hour/day of the period. */
export function fillTrend(keys: string[], rows: { k: string; users: number }[]): { label: string; users: number }[] {
	const m = new Map(rows.map((r) => [r.k, r.users]));
	return keys.map((k) => ({ label: k, users: m.get(k) ?? 0 }));
}

export async function usageDashboard(q: UsageQuery, now: Date = new Date()): Promise<UsageResult> {
	const { start, end, days } = periodBounds(q.period, q.tz, now);
	const hourly = q.period === 'today';
	// Exclude impersonated (admin read-only) sessions unless asked.
	const notStaff = q.includeStaff
		? sql`true`
		: sql`NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = a.session_id AND (s.impersonated_by IS NOT NULL OR s.read_only))`;
	const inRange = sql`a.created_at >= ${start} AND a.created_at < ${end} AND ${notStaff}`;

	const [totals] = await sql<{ active_users: number; logins: number; sessions: number; page_views: number }[]>`
		SELECT count(DISTINCT a.user_id) FILTER (WHERE a.event_type = 'login')::int AS active_users,
		       count(*) FILTER (WHERE a.event_type = 'login')::int AS logins,
		       count(DISTINCT a.session_id)::int AS sessions,
		       count(*) FILTER (WHERE a.event_type = 'page_view')::int AS page_views
		FROM activity_log a WHERE ${inRange}`;

	const topTime = await sql<{ path: string; total_ms: string; avg_ms: number; visits: number }[]>`
		SELECT a.event_data->>'path' AS path, sum((a.event_data->>'ms')::bigint)::text AS total_ms,
		       round(avg((a.event_data->>'ms')::numeric))::int AS avg_ms, count(*)::int AS visits
		FROM activity_log a WHERE a.event_type = 'page_time' AND a.event_data ? 'path' AND ${inRange}
		GROUP BY 1 ORDER BY sum((a.event_data->>'ms')::bigint) DESC LIMIT 10`;

	const topViews = await sql<{ path: string; views: number; users: number }[]>`
		SELECT a.event_data->>'path' AS path, count(*)::int AS views, count(DISTINCT a.user_id)::int AS users
		FROM activity_log a WHERE a.event_type = 'page_view' AND a.event_data ? 'path' AND ${inRange}
		GROUP BY 1 ORDER BY views DESC LIMIT 10`;

	// Daily (or, for Today, hourly) active users, bucketed in the admin's time zone.
	const bucket = hourly
		? sql`to_char(a.created_at AT TIME ZONE ${q.tz}, 'HH24')`
		: sql`to_char(a.created_at AT TIME ZONE ${q.tz}, 'YYYY-MM-DD')`;
	const trendRows = await sql<{ k: string; users: number }[]>`
		SELECT ${bucket} AS k, count(DISTINCT a.user_id)::int AS users
		FROM activity_log a WHERE a.event_type IN ('login', 'page_view', 'click', 'action') AND ${inRange}
		GROUP BY 1 ORDER BY 1`;
	const keys = hourly ? Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')) : days;

	const topAccounts = await sql<{ id: string; name: string; events: number; users: number }[]>`
		SELECT ac.id, ac.name, count(*)::int AS events, count(DISTINCT a.user_id)::int AS users
		FROM activity_log a JOIN accounts ac ON ac.id = a.account_id
		WHERE a.event_type IN ('page_view', 'click', 'action') AND ${inRange}
		GROUP BY ac.id, ac.name ORDER BY events DESC, ac.name LIMIT 10`;

	const topUsers = await sql<{ id: string; email: string; display_name: string | null; account: string | null; events: number }[]>`
		SELECT u.id, u.email, u.display_name, ac.name AS account, count(*)::int AS events
		FROM activity_log a JOIN users u ON u.id = a.user_id LEFT JOIN accounts ac ON ac.id = u.account_id
		WHERE a.event_type IN ('page_view', 'click', 'action') AND ${inRange}
		GROUP BY u.id, u.email, u.display_name, ac.name ORDER BY events DESC, u.email LIMIT 10`;

	return {
		period: q.period, tz: q.tz, includeStaff: q.includeStaff,
		range: { start: start.toISOString(), end: end.toISOString() },
		totals: { activeUsers: totals?.active_users ?? 0, logins: totals?.logins ?? 0, sessions: totals?.sessions ?? 0, pageViews: totals?.page_views ?? 0 },
		topTime: topTime.map((r) => ({ path: r.path, totalMs: Number(r.total_ms), avgMs: r.avg_ms, visits: r.visits })),
		topViews,
		trend: fillTrend(keys, trendRows),
		trendUnit: hourly ? 'hour' : 'day',
		topAccounts,
		topUsers: topUsers.map((u) => ({ id: u.id, email: u.email, name: u.display_name, account: u.account, events: u.events }))
	};
}
