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
import { hashPassword } from '../auth/password';
import { generateTempPassword } from '../auth/temp_password';

import { isValidTimeZone } from '../../admin/time';

export class StaffError extends Error {}

export interface StaffRow {
	user_id: string;
	email: string;
	display_name: string | null;
	role: PlatformRole;
	is_active: boolean;
	created_at: Date;
	mfa_enrolled: boolean;
	has_password: boolean;
	time_zone: string | null;
}

export async function listStaff(): Promise<StaffRow[]> {
	try {
		return await sql<StaffRow[]>`
			SELECT ps.user_id, ps.email, ps.display_name, ps.role, ps.is_active, ps.created_at,
			       (m.confirmed_at IS NOT NULL) AS mfa_enrolled, (ps.password_hash IS NOT NULL) AS has_password, ps.time_zone
			FROM platform_staff ps
			LEFT JOIN admin_mfa_credentials m ON m.user_id = ps.user_id
			ORDER BY ps.is_active DESC, ps.email
		`;
	} catch (e) {
		if ((e as { code?: string })?.code !== '42703') throw e; // migration 037 not applied yet
		return sql<StaffRow[]>`
			SELECT ps.user_id, ps.email, ps.display_name, ps.role, ps.is_active, ps.created_at,
			       (m.confirmed_at IS NOT NULL) AS mfa_enrolled, (ps.password_hash IS NOT NULL) AS has_password, NULL::text AS time_zone
			FROM platform_staff ps
			LEFT JOIN admin_mfa_credentials m ON m.user_id = ps.user_id
			ORDER BY ps.is_active DESC, ps.email
		`;
	}
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

export const MIN_ADMIN_PASSWORD = 12;

/**
 * Set or reset an admin's password (also the "setup" path for an admin that has no password yet).
 * Either pass `password` (min 12 chars) or omit it to generate a one-time temporary password, returned ONCE.
 * Clears must_reset_password (admins have no self-service change page, so a forced reset would lock them out)
 * and signs the admin out everywhere. The password is never logged or audited.
 */
export async function setStaffPassword(args: {
	userId: string;
	password?: string | null;
	actor: AuditActor;
	reason: string;
	ip?: string | null;
}): Promise<{ generated: string | null }> {
	if (args.userId === args.actor.userId) throw new StaffError('Use the operator CLI to change your own password.');
	const supplied = args.password?.trim() ? args.password : null;
	if (supplied && (supplied.length < MIN_ADMIN_PASSWORD || supplied.length > 200)) throw new StaffError(`Password must be ${MIN_ADMIN_PASSWORD}–200 characters.`);
	const password = supplied ?? generateTempPassword();
	const hash = await hashPassword(password);
	await sql.begin(async (tx) => {
		const [row] = await tx<{ password_hash: string | null; is_active: boolean }[]>`SELECT password_hash, is_active FROM platform_staff WHERE user_id = ${args.userId} FOR UPDATE`;
		if (!row) throw new StaffError('That user is not platform staff.');
		if (!row.is_active) throw new StaffError('That staff member is deactivated. Re-activate them first.');
		await tx`UPDATE platform_staff SET password_hash = ${hash}, must_reset_password = false WHERE user_id = ${args.userId}`;
		await revokeAllAdminSessionsForUser(args.userId, 'password_changed', args.actor.userId, tx as unknown as Sql);
		await recordAudit(
			{
				actor: args.actor, action: row.password_hash ? 'staff.password_reset' : 'staff.password_set', targetType: 'user', targetId: args.userId,
				outcome: 'success', reason: args.reason, ip: args.ip, metadata: { generated: !supplied }
			},
			tx
		);
	});
	return { generated: supplied ? null : password };
}

/** Set (or clear with null/'') an admin's display time zone. Stored value is an IANA name; data stays UTC. */
export async function setStaffTimeZone(args: { userId: string; timeZone: string | null; actor: AuditActor; ip?: string | null }): Promise<void> {
	const tz = args.timeZone?.trim() || null;
	if (tz !== null && !isValidTimeZone(tz)) throw new StaffError('Choose a valid time zone.');
	const rows = await sql<{ user_id: string }[]>`UPDATE platform_staff SET time_zone = ${tz} WHERE user_id = ${args.userId} RETURNING user_id`;
	if (!rows.length) throw new StaffError('That user is not platform staff.');
	await recordAudit({ actor: args.actor, action: 'staff.time_zone_set', targetType: 'user', targetId: args.userId, outcome: 'success', ip: args.ip, metadata: { timeZone: tz } });
}
