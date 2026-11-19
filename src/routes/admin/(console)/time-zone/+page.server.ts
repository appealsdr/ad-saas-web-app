import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { auditActor, clientIp, requireStaff } from '$lib/server/admin/guard';
import { StaffError, setStaffTimeZone } from '$lib/server/admin/staff';
import { listTimeZones } from '$lib/admin/time';

export const load: PageServerLoad = (event) => {
	const staff = requireStaff(event);
	return { current: staff.timeZone, zones: listTimeZones() };
};

export const actions: Actions = {
	// Any signed-in admin may set THEIR OWN display time zone (display only; no stored timestamps change).
	default: async (event) => {
		const staff = requireStaff(event);
		const d = await event.request.formData();
		try {
			await setStaffTimeZone({ userId: staff.userId, timeZone: String(d.get('timeZone') ?? ''), actor: auditActor(staff), ip: clientIp(event) });
			return { ok: 'Time zone saved.' };
		} catch (e) {
			if (e instanceof StaffError) return fail(400, { error: e.message });
			throw e;
		}
	}
};
