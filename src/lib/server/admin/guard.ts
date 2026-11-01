/**
 * Reusable server guards. Call these in EVERY admin load, form action and API
 * handler — layout checks and hidden buttons are not authorization.
 *
 * `event.locals.staff` is populated by hooks.server.ts, which re-validates the
 * session AND the staff membership on each request. If anything is missing or
 * the lookup failed, these fail closed.
 */
import { error, redirect, type RequestEvent } from '@sveltejs/kit';
import { roleHas, type Permission } from './permissions';
import type { StaffContext } from './sessions';

type Ev = Pick<RequestEvent, 'locals' | 'url' | 'request'>;

export interface GuardOptions {
	/** Require MFA to have been (re)verified within the freshness window. */
	freshMfa?: boolean;
}

export function requireStaff(event: Ev, permission?: Permission, opts: GuardOptions = {}): StaffContext {
	const staff = event.locals.staff;
	const isRead = event.request.method === 'GET' || event.request.method === 'HEAD';

	if (!staff) {
		if (isRead) {
			const next = encodeURIComponent(event.url.pathname + event.url.search);
			throw redirect(303, `/admin/login?next=${next}`);
		}
		throw error(401, 'Authentication required.');
	}
	if (permission && !roleHas(staff.role, permission)) {
		throw error(403, 'You do not have permission to do that.');
	}
	if (opts.freshMfa && !staff.freshMfa) {
		if (isRead) {
			const next = encodeURIComponent(event.url.pathname + event.url.search);
			throw redirect(303, `/admin/reauth?next=${next}`);
		}
		throw error(403, 'Recent MFA verification required. Re-verify at /admin/reauth and retry.');
	}
	return staff;
}

export function auditActor(staff: StaffContext) {
	return { userId: staff.userId, ref: staff.email, role: staff.role };
}

export function clientIp(event: Pick<RequestEvent, 'getClientAddress'>): string {
	try {
		return event.getClientAddress();
	} catch {
		return 'unknown';
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
	return typeof v === 'string' && UUID_RE.test(v);
}
export function requireUuidParam(v: string | undefined): string {
	if (!isUuid(v)) throw error(404, 'Not found.');
	return v;
}
