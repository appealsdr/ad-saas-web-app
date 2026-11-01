/**
 * App activity tracking (activity_log).
 *
 * One row per event, attributed to the signed-in user + account + session:
 *   login / logout   sign-in and sign-out
 *   page_view        a page the user opened   {path, from, title, msOnPrev}
 *   click            a link/button they used  {path, label, href}
 *   action           a change they submitted  {method, path, action, status}
 *
 * Never stored: form values, typed text, query strings, cookies. Writes are
 * fire-and-forget — tracking must never slow down or break a request.
 */
import { sql } from './db';

export type ActivityType = 'login' | 'logout' | 'page_view' | 'click' | 'action';
export const CLIENT_ACTIVITY_TYPES: ActivityType[] = ['page_view', 'click'];

export interface ActivityInput {
	userId: string;
	accountId: string | null;
	sessionId: string | null;
	type: ActivityType;
	data: Record<string, unknown>;
	ip?: string | null;
	requestId?: string | null;
	at?: Date;
}

const clip = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : undefined);

/** Path only — never a query string or fragment. */
export function cleanPath(v: unknown): string | undefined {
	if (typeof v !== 'string') return undefined;
	try {
		return new URL(v, 'http://x').pathname.slice(0, 300);
	} catch {
		return undefined;
	}
}

export function logActivity(a: ActivityInput): void {
	const validIp = a.ip && /^[0-9a-fA-F:.]+$/.test(a.ip) ? a.ip : null;
	void sql`
		INSERT INTO activity_log (user_id, account_id, session_id, event_type, event_data, ip_address, request_id, created_at)
		VALUES (${a.userId}, COALESCE(${a.accountId}::uuid, (SELECT account_id FROM users WHERE id = ${a.userId})), ${a.sessionId}, ${a.type}, ${sql.json(a.data as Parameters<typeof sql.json>[0])},
		        ${validIp}, ${a.requestId ?? null}, ${a.at ?? new Date()})
	`.catch((e) => console.error('activity: insert failed', e instanceof Error ? e.message : e));
}

/** Validate/shape one client-reported event. Returns null for anything unexpected. */
export function shapeClientEvent(raw: unknown): { type: ActivityType; data: Record<string, unknown>; at: Date } | null {
	if (!raw || typeof raw !== 'object') return null;
	const e = raw as Record<string, unknown>;
	const type = e.type as ActivityType;
	if (!CLIENT_ACTIVITY_TYPES.includes(type)) return null;
	const path = cleanPath(e.path);
	if (!path) return null;
	const ts = typeof e.ts === 'number' ? e.ts : Date.now();
	// Accept client clocks only within a sane window; otherwise stamp server time.
	const at = Math.abs(Date.now() - ts) < 10 * 60_000 ? new Date(ts) : new Date();
	if (type === 'page_view') {
		return {
			type,
			at,
			data: {
				path,
				from: cleanPath(e.from),
				title: clip(e.title, 120),
				msOnPrev: typeof e.msOnPrev === 'number' && e.msOnPrev >= 0 && e.msOnPrev < 6 * 3600_000 ? Math.round(e.msOnPrev) : undefined
			}
		};
	}
	return { type, at, data: { path, label: clip(e.label, 80), href: cleanPath(e.href), kind: clip(e.kind, 20) } };
}
