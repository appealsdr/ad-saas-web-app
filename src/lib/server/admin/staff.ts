/**
 * Staff membership management. Serialised by an advisory lock + the
 * platform_staff_guard_last_admin trigger so concurrent changes can never
 * remove the last active platform_admin.
 */
import type { Sql } from 'postgres';
import { sql } from '../db';
import { recordAudit, type AuditActor } from './audit';
import { revokeAllAdminSessionsForUser } from './sessions';
import { isPlatformRole, type PlatformRole } from './permissions';

export class StaffError extends Error {}

export interface StaffRow {
	user_id: string;
	email: string;
	display_name: string | null;
	role: PlatformRole;
	is_active: boolean;
	created_at: Date;
	mfa_enrolled: boolean;
}

export async function listStaff(): Promise<StaffRow[]> {
	return sql<StaffRow[]>`
		SELECT ps.user_id, ps.email, ps.display_name, ps.role, ps.is_active, ps.created_at,
		       (m.confirmed_at IS NOT NULL) AS mfa_enrolled
		FROM platform_staff ps
		LEFT JOIN admin_mfa_credentials m ON m.user_id = ps.user_id
		ORDER BY ps.is_active DESC, ps.email
	`;
}

/**
 * Change the role of an EXISTING platform admin (or re-activate them), identified by email. Idempotent.
 * Admin accounts are standalone and are created from the operator console (scripts/admin-cli.mjs create) —
 * never by promoting a customer user.
 */
export async function setStaffRole(args: {
	email: string;
	role: PlatformRole;
	actor: AuditActor;
	reason?: string;
	ip?: string | null;
}): Promise<{ userId: string; changed: boolean }> {
	if (!isPlatformRole(args.role)) throw new StaffError('Unknown platform role.');
	const email = args.email.trim().toLowerCase();
	return sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtext('platform_staff_membership'))`;
		const [existing] = await tx<{ user_id: string; role: string; is_active: boolean }[]>`
			SELECT user_id, role, is_active FROM platform_staff WHERE lower(email) = ${email}
		`;
		if (!existing) throw new StaffError('No platform admin with that email. Create one from the console first.');
		const unchanged = existing.role === args.role && existing.is_active;
		if (!unchanged) {
			await tx`
				UPDATE platform_staff SET role = ${args.role}, is_active = true, deactivated_at = NULL,
				       granted_by = ${args.actor.userId}, granted_by_ref = ${args.actor.ref}
				WHERE user_id = ${existing.user_id}
			`; // trigger raises 23514 when demoting the last active platform_admin
			if (existing.role !== args.role) {
				await revokeAllAdminSessionsForUser(existing.user_id, 'role_changed', args.actor.userId, tx as unknown as Sql);
			}
		}
		await recordAudit(
			{
				actor: args.actor,
				action: 'staff.grant',
				targetType: 'user',
				targetId: existing.user_id,
				outcome: 'success',
				reason: args.reason ?? null,
				ip: args.ip,
				metadata: { email, role: args.role, previousRole: existing.role, changed: !unchanged }
			},
			tx
		);
		return { userId: existing.user_id, changed: !unchanged };
	}).catch((e) => {
		if ((e as { code?: string }).code === '23514') throw new StaffError('Cannot remove the last active platform administrator.');
		throw e;
	});
}

/**
 * Create a STANDALONE platform admin: its own email, password and MFA. The email may equal a customer's — they are
 * different identities. Used by the console CLI; the password is hashed here and never logged.
 */
export async function createStaff(args: {
	email: string;
	displayName?: string | null;
	role: PlatformRole;
	passwordHash: string;
	mustResetPassword?: boolean;
	actor: AuditActor;
	ip?: string | null;
}): Promise<{ userId: string }> {
	if (!isPlatformRole(args.role)) throw new StaffError('Unknown platform role.');
	const email = args.email.trim().toLowerCase();
	if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new StaffError('Enter a valid email address.');
	return sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtext('platform_staff_membership'))`;
		const [dup] = await tx`SELECT 1 FROM platform_staff WHERE lower(email) = ${email}`;
		if (dup) throw new StaffError('A platform admin with that email already exists.');
		const [row] = await tx<{ user_id: string }[]>`
			INSERT INTO platform_staff (role, email, display_name, password_hash, must_reset_password, is_active, granted_by, granted_by_ref)
			VALUES (${args.role}, ${email}, ${args.displayName?.trim() || null}, ${args.passwordHash}, ${args.mustResetPassword ?? false}, true,
			        ${args.actor.userId}, ${args.actor.ref})
			RETURNING user_id
		`;
		await recordAudit(
			{ actor: args.actor, action: 'staff.created', targetType: 'user', targetId: row.user_id, outcome: 'success', ip: args.ip, metadata: { email, role: args.role } },
			tx
		);
		return { userId: row.user_id };
	});
}

export async function deactivateStaff(args: {
	userId: string;
	actor: AuditActor;
	reason: string;
	ip?: string | null;
}): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`SELECT pg_advisory_xact_lock(hashtext('platform_staff_membership'))`;
		const rows = await tx<{ user_id: string }[]>`
			UPDATE platform_staff SET is_active = false, deactivated_at = now()
			WHERE user_id = ${args.userId} AND is_active
			RETURNING user_id
		`; // trigger raises 23514 if this is the last active platform_admin
		if (!rows.length) throw new StaffError('That user is not active staff.');
		await revokeAllAdminSessionsForUser(args.userId, 'staff_deactivated', args.actor.userId, tx as unknown as Sql);
		await recordAudit(
			{ actor: args.actor, action: 'staff.deactivate', targetType: 'user', targetId: args.userId, outcome: 'success', reason: args.reason, ip: args.ip },
			tx
		);
	}).catch((e) => {
		if ((e as { code?: string }).code === '23514') throw new StaffError('Cannot remove the last active platform administrator.');
		throw e;
	});
}

/** MFA reset / recovery: drops credentials + recovery codes and revokes sessions. */
export async function resetStaffMfa(args: { userId: string; actor: AuditActor; reason: string; ip?: string | null }): Promise<void> {
	await sql.begin(async (tx) => {
		await tx`DELETE FROM admin_mfa_credentials WHERE user_id = ${args.userId}`;
		await tx`DELETE FROM admin_recovery_codes WHERE user_id = ${args.userId}`;
		await tx`UPDATE admin_login_challenges SET consumed_at = now() WHERE user_id = ${args.userId} AND consumed_at IS NULL`;
		await revokeAllAdminSessionsForUser(args.userId, 'mfa_reset', args.actor.userId, tx as unknown as Sql);
		await recordAudit(
			{ actor: args.actor, action: 'staff.mfa_reset', targetType: 'user', targetId: args.userId, outcome: 'success', reason: args.reason, ip: args.ip },
			tx
		);
	});
}
