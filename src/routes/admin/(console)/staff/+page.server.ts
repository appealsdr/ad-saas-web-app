import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auditActor, clientIp, isUuid, requireStaff } from '$lib/server/admin/guard';
import { StaffError, deactivateStaff, setStaffRole, listStaff, resetStaffMfa, setStaffPassword, createStaff, MIN_ADMIN_PASSWORD } from '$lib/server/admin/staff';
import { isPlatformRole } from '$lib/server/admin/permissions';
import { hashPassword } from '$lib/server/auth/password';
import { generateTempPassword } from '$lib/server/auth/temp_password';
import { requireReason, ActionError } from '$lib/server/admin/actions';

export const load: PageServerLoad = async (event) => {
	const staff = requireStaff(event, 'staff.manage');
	return { staff: await listStaff(), me: staff.userId, fresh: staff.freshMfa };
};

// Membership changes need staff.manage AND MFA verified within the last 5 minutes.
const guard = (event: Parameters<typeof requireStaff>[0]) => requireStaff(event, 'staff.manage', { freshMfa: true });

export const actions: Actions = {
	grant: async (event) => {
		const staff = guard(event);
		const d = await event.request.formData();
		const role = String(d.get('role') ?? '');
		if (!isPlatformRole(role)) return fail(400, { error: 'Unknown role.' });
		try {
			const reason = requireReason(String(d.get('reason') ?? ''));
			const r = await setStaffRole({ email: String(d.get('email') ?? ''), role, actor: auditActor(staff), reason, ip: clientIp(event) });
			return { ok: r.changed ? 'Role saved.' : 'No change (already that role).' };
		} catch (e) {
			if (e instanceof StaffError || e instanceof ActionError) return fail(400, { error: e.message });
			throw e;
		}
	},
	deactivate: async (event) => {
		const staff = guard(event);
		const d = await event.request.formData();
		const userId = String(d.get('userId') ?? '');
		if (!isUuid(userId)) return fail(400, { error: 'Invalid request.' });
		try {
			await deactivateStaff({ userId, actor: auditActor(staff), reason: requireReason(String(d.get('reason') ?? '')), ip: clientIp(event) });
			return { ok: 'Staff member deactivated and signed out.' };
		} catch (e) {
			if (e instanceof StaffError || e instanceof ActionError) return fail(400, { error: e.message });
			throw e;
		}
	},
	create_admin: async (event) => {
		const staff = guard(event);
		const d = await event.request.formData();
		const role = String(d.get('role') ?? '');
		if (!isPlatformRole(role)) return fail(400, { error: 'Unknown role.' });
		const email = String(d.get('email') ?? '').trim().toLowerCase();
		const supplied = String(d.get('password') ?? '');
		if (supplied && (supplied.length < MIN_ADMIN_PASSWORD || supplied.length > 200)) return fail(400, { error: `Password must be ${MIN_ADMIN_PASSWORD}–200 characters.` });
		try {
			requireReason(String(d.get('reason') ?? ''));
			const password = supplied || generateTempPassword();
			await createStaff({ email, displayName: String(d.get('name') ?? ''), role, passwordHash: await hashPassword(password), actor: auditActor(staff), ip: clientIp(event) });
			return { ok: `Admin ${email} created. They enrol MFA at first sign-in at /admin/login.`, tempPassword: supplied ? null : password, tempFor: email };
		} catch (e) {
			if (e instanceof StaffError || e instanceof ActionError) return fail(400, { error: e.message });
			throw e;
		}
	},
	set_role: async (event) => {
		const staff = guard(event);
		const d = await event.request.formData();
		const role = String(d.get('role') ?? '');
		if (!isPlatformRole(role)) return fail(400, { error: 'Unknown role.' });
		const email = String(d.get('email') ?? '');
		if (email.trim().toLowerCase() === staff.email.toLowerCase()) return fail(400, { error: 'You cannot change your own role.' });
		try {
			const r = await setStaffRole({ email, role, actor: auditActor(staff), reason: requireReason(String(d.get('reason') ?? '')), ip: clientIp(event) });
			return { ok: r.changed ? `Role changed to ${role}. They were signed out everywhere.` : 'No change (already that role).' };
		} catch (e) {
			if (e instanceof StaffError || e instanceof ActionError) return fail(400, { error: e.message });
			throw e;
		}
	},
	set_password: async (event) => {
		const staff = guard(event);
		const d = await event.request.formData();
		const userId = String(d.get('userId') ?? '');
		if (!isUuid(userId)) return fail(400, { error: 'Invalid request.' });
		try {
			const r = await setStaffPassword({
				userId, password: String(d.get('password') ?? ''), actor: auditActor(staff),
				reason: requireReason(String(d.get('reason') ?? '')), ip: clientIp(event)
			});
			return { ok: 'Password saved. They were signed out everywhere and must sign in with the new password.', tempPassword: r.generated, tempFor: String(d.get('email') ?? '') };
		} catch (e) {
			if (e instanceof StaffError || e instanceof ActionError) return fail(400, { error: e.message });
			throw e;
		}
	},
	reset_mfa: async (event) => {
		const staff = guard(event);
		const d = await event.request.formData();
		const userId = String(d.get('userId') ?? '');
		if (!isUuid(userId)) return fail(400, { error: 'Invalid request.' });
		try {
			await resetStaffMfa({ userId, actor: auditActor(staff), reason: requireReason(String(d.get('reason') ?? '')), ip: clientIp(event) });
			return { ok: 'MFA reset. They must enrol again at next sign-in.' };
		} catch (e) {
			if (e instanceof ActionError) return fail(400, { error: e.message });
			throw e;
		}
	}
};
