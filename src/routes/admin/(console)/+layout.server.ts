import type { LayoutServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';
import { roleHas } from '$lib/server/admin/permissions';

// NOTE: every page load and action ALSO calls requireStaff with its own permission.
// This layout check only drives navigation; it is not the authorization boundary.
export const load: LayoutServerLoad = async (event) => {
	const staff = requireStaff(event);
	return {
		staff: { email: staff.email, displayName: staff.displayName, role: staff.role, freshMfa: staff.freshMfa },
		can: {
			data: roleHas(staff.role, 'data.read'),
			query: roleHas(staff.role, 'data.query'),
			staff: roleHas(staff.role, 'staff.manage'),
			logs: roleHas(staff.role, 'logs.read')
		}
	};
};
