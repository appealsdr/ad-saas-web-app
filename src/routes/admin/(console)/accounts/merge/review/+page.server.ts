import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireStaff, auditActor, clientIp, isUuid } from '$lib/server/admin/guard';
import { roleHas } from '$lib/server/admin/permissions';
import { ActionError, EDITABLE_ACCOUNT_FIELDS, type EditableAccountField } from '$lib/server/admin/actions';
import { defaultChoices, loadMergeSide, mergeAccounts, type MergeChoices, type UserDecision } from '$lib/server/admin/merge';
import { describeError } from '$lib/server/error_log';

const LABELS: Record<EditableAccountField, string> = {
	name: 'Company name', email: 'Email', phone: 'Phone', website: 'Website', billing_street: 'Billing street',
	billing_city: 'Billing city', billing_state: 'Billing state', billing_postal_code: 'Billing postal code', billing_country: 'Billing country'
};

export const load: PageServerLoad = async (event) => {
	const staff = requireStaff(event, 'accounts.read');
	const keep = event.url.searchParams.get('keep') ?? '';
	const from = event.url.searchParams.get('from') ?? '';
	if (!isUuid(keep) || !isUuid(from) || keep === from) throw redirect(303, '/admin/accounts/merge');
	try {
		const [survivor, source] = await Promise.all([loadMergeSide(keep), loadMergeSide(from)]);
		if (!survivor || !source) throw redirect(303, '/admin/accounts/merge');
		return {
			error: null as string | null,
			canMerge: roleHas(staff.role, 'accounts.update'),
			survivor, source,
			defaults: defaultChoices(survivor, source),
			fields: EDITABLE_ACCOUNT_FIELDS.map((f) => ({ key: f, label: LABELS[f], survivor: survivor.account[f] ?? null, source: source.account[f] ?? null }))
		};
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && 'location' in e) throw e; // redirect
		const code = (e as { code?: string })?.code;
		const msg = code === '42703' || code === '42P01'
			? 'The merge tables are missing. Apply migration 036_account_merge.sql, then reload.'
			: describeError(e).errorMessage;
		return { error: msg, canMerge: false, survivor: null, source: null, defaults: null, fields: [] };
	}
};

export const actions: Actions = {
	merge: async (event) => {
		const staff = requireStaff(event, 'accounts.update', { freshMfa: true });
		const d = await event.request.formData();
		const keep = String(d.get('keep') ?? '');
		const from = String(d.get('from') ?? '');
		if (!isUuid(keep) || !isUuid(from)) return fail(400, { error: 'Invalid request.' });

		const fields: MergeChoices['fields'] = {};
		for (const f of EDITABLE_ACCOUNT_FIELDS) fields[f] = d.get(`f_${f}`) === 'source' ? 'source' : 'survivor';
		const users: Record<string, UserDecision> = {};
		for (const [k, v] of d.entries()) if (k.startsWith('u_')) users[k.slice(2)] = String(v) as UserDecision;

		const choices: MergeChoices = {
			fields,
			stripe: d.get('stripe') === 'source' ? 'source' : 'survivor',
			users,
			storeIds: d.getAll('storeId').map(String),
			contractIds: d.getAll('contractId').map(String),
			contacts: d.get('contacts') === 'on',
			activity: d.get('activity') === 'on',
			salesforce: d.get('salesforce') === 'on',
			reason: String(d.get('reason') ?? ''),
			confirm: String(d.get('confirm') ?? '')
		};
		try {
			return { ok: { keep, ...(await mergeAccounts({ actor: auditActor(staff), ip: clientIp(event) }, keep, from, choices)) } };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message });
			throw e;
		}
	}
};
