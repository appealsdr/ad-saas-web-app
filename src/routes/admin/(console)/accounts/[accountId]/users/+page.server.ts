import { fail } from '@sveltejs/kit';
import { sql } from '$lib/server/db';
import { salesforceUrl } from '$lib/server/admin/links';
import { redirect } from '@sveltejs/kit';
import { createSession } from '$lib/server/auth/session';
import { setSessionCookie } from '$lib/server/auth/cookie';
import { recordAudit } from '$lib/server/admin/audit';
import { requireReason } from '$lib/server/admin/actions';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { sfExisting, sfState } from '$lib/server/admin/sf_sync';
import { resyncAction } from '$lib/server/admin/resync_action';
import { listAccountUsers } from '$lib/server/admin/accounts';
import { roleHas } from '$lib/server/admin/permissions';
import { auditActor, clientIp, isUuid } from '$lib/server/admin/guard';
import { ActionError, initiatePasswordReset, manageCustomerUser, setTemporaryPassword, type UserAction } from '$lib/server/admin/actions';

export const load: PageServerLoad = async (event) => {
	const { staff, accountId } = await workspace(event, 'users.read');
	const users = await listAccountUsers(accountId);
	const links = await sql<{ id: string; sfdc_contact_id: string | null }[]>`SELECT id, sfdc_contact_id FROM users WHERE account_id = ${accountId}`;
	const linkBy = new Map(links.map((l) => [l.id, l.sfdc_contact_id]));
	const existing = await sfExisting('Contact', links.map((l) => l.sfdc_contact_id));
	return {
		users: await Promise.all(users.map(async (u) => ({ ...u, sfdc_contact_id: linkBy.get(u.id) ?? null, sfState: sfState(linkBy.get(u.id), existing), sfUrl: await salesforceUrl('Contact', linkBy.get(u.id)) }))),
		canManage: roleHas(staff.role, 'users.manage'),
		canSync: roleHas(staff.role, 'accounts.update')
	};
};

const ACTIONS: UserAction[] = ['suspend', 'reactivate', 'unlock', 'revoke_sessions'];

const VIEW_AS_TTL_MS = 30 * 60 * 1000;

export const actions: Actions = {
	/** Open a read-only customer session for this user (30 min). MFA-fresh, reasoned, audited. */
	impersonate: async (event) => {
		const { staff, accountId } = await workspace(event, 'users.manage', { freshMfa: true });
		const d = await event.request.formData();
		const userId = String(d.get('userId') ?? '');
		if (!isUuid(userId)) return fail(400, { error: 'Invalid request.' });
		let reason: string;
		try { reason = requireReason(String(d.get('reason') ?? '')); } catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message, userId });
			throw e;
		}
		const [u] = await sql<{ id: string; email: string; is_active: boolean; staff: boolean }[]>`
			SELECT u.id, u.email, u.is_active, (ps.user_id IS NOT NULL) AS staff
			FROM users u LEFT JOIN platform_staff ps ON ps.user_id = u.id
			WHERE u.id = ${userId} AND u.account_id = ${accountId}`;
		if (!u) return fail(404, { error: 'User not found on this account.', userId });
		if (!u.is_active) return fail(409, { error: 'This user is suspended — reactivate them first.', userId });
		if (u.staff) return fail(409, { error: 'Platform staff cannot be viewed as customers.', userId });

		const session = await createSession(u.id, {
			ipAddress: clientIp(event),
			userAgent: event.request.headers.get('user-agent') ?? undefined,
			impersonatedBy: staff.userId,
			ttlMs: VIEW_AS_TTL_MS
		});
		await recordAudit({
			actor: auditActor(staff), action: 'user.view_as', targetType: 'user', targetId: u.id,
			targetAccountId: accountId, outcome: 'success', reason, ip: clientIp(event),
			metadata: { targetEmail: u.email, readOnly: true, minutes: VIEW_AS_TTL_MS / 60000 }
		});
		setSessionCookie(event.cookies, event, session.rawToken, VIEW_AS_TTL_MS / 1000);
		throw redirect(303, '/dashboard');
	},
	resync: resyncAction,
	manage: async (event) => {
		const { staff, accountId } = await workspace(event, 'users.manage');
		const d = await event.request.formData();
		const userId = String(d.get('userId') ?? '');
		const action = String(d.get('action') ?? '') as UserAction;
		if (!isUuid(userId) || !ACTIONS.includes(action)) return fail(400, { error: 'Invalid request.' });
		try {
			const r = await manageCustomerUser(
				{ actor: auditActor(staff), ip: clientIp(event) },
				accountId, userId, action,
				String(d.get('reason') ?? ''), String(d.get('confirm') ?? '')
			);
			return { ok: r.message };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message, userId });
			throw e;
		}
	},
	reset: async (event) => {
		const { staff, accountId } = await workspace(event, 'users.manage');
		const d = await event.request.formData();
		const userId = String(d.get('userId') ?? '');
		if (!isUuid(userId)) return fail(400, { error: 'Invalid request.' });
		try {
			const r = await initiatePasswordReset(
				{ actor: auditActor(staff), ip: clientIp(event), origin: event.url.origin },
				accountId, userId,
				String(d.get('reason') ?? ''), String(d.get('confirm') ?? '')
			);
			return { ok: r.message };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message, userId });
			throw e;
		}
	},
	temp: async (event) => {
		const { staff, accountId } = await workspace(event, 'users.manage');
		const d = await event.request.formData();
		const userId = String(d.get('userId') ?? '');
		if (!isUuid(userId)) return fail(400, { error: 'Invalid request.' });
		try {
			const r = await setTemporaryPassword(
				{ actor: auditActor(staff), ip: clientIp(event) },
				accountId, userId,
				String(d.get('reason') ?? ''), String(d.get('confirm') ?? '')
			);
			return { ok: r.message, tempPassword: r.tempPassword, userId };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message, userId });
			throw e;
		}
	}
};
