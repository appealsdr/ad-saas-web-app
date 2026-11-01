/** Read-side queries for the admin "App activity" tab (activity_log, scoped to one account). */
import { sql } from '../db';

export interface ActivityQuery { accountId: string; days: number; userId: string | null; type: string | null }

export const RANGES = [1, 7, 30, 90];
export const TYPES = ['page_view', 'click', 'action', 'login', 'logout'];

export function parseActivityQuery(accountId: string, p: URLSearchParams): ActivityQuery {
	const d = Number(p.get('days'));
	const u = p.get('user') ?? '';
	const t = p.get('type') ?? '';
	return {
		accountId,
		days: RANGES.includes(d) ? d : 7,
		userId: /^[0-9a-f-]{36}$/i.test(u) ? u : null,
		type: TYPES.includes(t) ? t : null
	};
}

export async function appActivity(q: ActivityQuery) {
	const since = new Date(Date.now() - q.days * 86_400_000);
	const base = sql`a.account_id = ${q.accountId} AND a.created_at >= ${since} AND (${q.userId}::uuid IS NULL OR a.user_id = ${q.userId})`;

	const [totals] = await sql<{ events: number; users: number; sessions: number; page_views: number; clicks: number; actions: number; logins: number; last_at: Date | null }[]>`
		SELECT count(*)::int AS events, count(DISTINCT a.user_id)::int AS users, count(DISTINCT a.session_id)::int AS sessions,
		       count(*) FILTER (WHERE a.event_type = 'page_view')::int AS page_views,
		       count(*) FILTER (WHERE a.event_type = 'click')::int AS clicks,
		       count(*) FILTER (WHERE a.event_type = 'action')::int AS actions,
		       count(*) FILTER (WHERE a.event_type = 'login')::int AS logins,
		       max(a.created_at) AS last_at
		FROM activity_log a WHERE ${base}`;

	const perUser = await sql<{ id: string; email: string; display_name: string | null; role: string; page_views: number; clicks: number; actions: number; logins: number; sessions: number; last_at: Date | null; top_page: string | null }[]>`
		SELECT u.id, u.email, u.display_name, u.role,
		       count(a.*) FILTER (WHERE a.event_type = 'page_view')::int AS page_views,
		       count(a.*) FILTER (WHERE a.event_type = 'click')::int AS clicks,
		       count(a.*) FILTER (WHERE a.event_type = 'action')::int AS actions,
		       count(a.*) FILTER (WHERE a.event_type = 'login')::int AS logins,
		       count(DISTINCT a.session_id)::int AS sessions,
		       max(a.created_at) AS last_at,
		       (SELECT p.event_data->>'path' FROM activity_log p
		         WHERE p.user_id = u.id AND p.event_type = 'page_view' AND p.created_at >= ${since}
		         GROUP BY 1 ORDER BY count(*) DESC LIMIT 1) AS top_page
		FROM users u
		LEFT JOIN activity_log a ON a.user_id = u.id AND a.account_id = ${q.accountId} AND a.created_at >= ${since}
		WHERE u.account_id = ${q.accountId} AND (${q.userId}::uuid IS NULL OR u.id = ${q.userId})
		GROUP BY u.id ORDER BY max(a.created_at) DESC NULLS LAST, u.email`;

	const topPages = await sql<{ path: string; views: number; users: number; avg_ms: number | null }[]>`
		SELECT a.event_data->>'path' AS path, count(*)::int AS views, count(DISTINCT a.user_id)::int AS users,
		       round(avg(NULLIF((a.event_data->>'msOnPrev')::numeric, 0)))::int AS avg_ms
		FROM activity_log a WHERE ${base} AND a.event_type = 'page_view' AND a.event_data ? 'path'
		GROUP BY 1 ORDER BY views DESC LIMIT 15`;

	const topClicks = await sql<{ label: string; path: string; n: number }[]>`
		SELECT coalesce(a.event_data->>'label', a.event_data->>'href') AS label, a.event_data->>'path' AS path, count(*)::int AS n
		FROM activity_log a WHERE ${base} AND a.event_type = 'click'
		GROUP BY 1, 2 HAVING coalesce(a.event_data->>'label', a.event_data->>'href') IS NOT NULL
		ORDER BY n DESC LIMIT 12`;

	const daily = await sql<{ day: string; events: number; users: number }[]>`
		SELECT to_char(date_trunc('day', a.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::int AS events, count(DISTINCT a.user_id)::int AS users
		FROM activity_log a WHERE ${base} GROUP BY 1 ORDER BY 1`;

	const recent = await sql<{ id: string; created_at: Date; event_type: string; event_data: Record<string, unknown> | null; user_id: string | null; email: string | null; display_name: string | null }[]>`
		SELECT a.id, a.created_at, a.event_type, a.event_data, a.user_id, u.email, u.display_name
		FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
		WHERE ${base} AND (${q.type}::text IS NULL OR a.event_type = ${q.type})
		ORDER BY a.created_at DESC, a.id DESC LIMIT 150`;

	return { totals, perUser, topPages, topClicks, daily, recent };
}
