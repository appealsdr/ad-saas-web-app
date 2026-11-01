import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { roleHas } from '$lib/server/admin/permissions';
import { auditActor, clientIp, isUuid } from '$lib/server/admin/guard';
import { ActionError } from '$lib/server/admin/actions';
import { sfExisting, sfState } from '$lib/server/admin/sf_sync';
import { resyncAction } from '$lib/server/admin/resync_action';
import { sql } from '$lib/server/db';
import { listCasesForStore } from '$lib/server/salesforce';
import { listAccountStores } from '$lib/server/admin/accounts';
import { accountContracts } from '$lib/server/admin/billing';
import { salesforceUrl, stripeUrl } from '$lib/server/admin/links';
import { buildDetailGroups } from '$lib/server/admin/records';
import { initiatePasswordReset, setTemporaryPassword } from '$lib/server/admin/actions';
import { deleteRecord, getRecord, RECORD_KINDS, SF_OBJECT, updateRecord, type RecordKind } from '$lib/server/admin/records';

export interface StoreExtra {
	name: string; marketplaces: string | null; country: string | null; sellerId: string | null; storeEmail: string | null;
	businessName: string | null; sellerPrimaryEmail: string | null; description: string | null; createdAt: string;
	pocName: string | null; pocEmail: string | null; spapiStatus: string; spapiConnectedAt: string | null; spapiLastError: string | null;
	cases: { id: string; number: string; service: string; status: string; priority: string | null; opened: string; modified: string }[];
	casesError: string | null;
	docs: { kind: 'store' | 'case'; id: string; original_name: string; mime_type: string | null; size_bytes: string; sfdc_case_id: string | null; created_at: string }[];
}

function parse(params: { kind: string; recordId: string }) {
	if (!RECORD_KINDS.includes(params.kind as RecordKind) || !isUuid(params.recordId)) throw error(404, 'Not found.');
	return { kind: params.kind as RecordKind, id: params.recordId };
}

export const load: PageServerLoad = async (event) => {
	const { staff, accountId } = await workspace(event, 'accounts.read');
	const { kind, id } = parse(event.params);
	const record = await getRecord(accountId, kind, id);
	if (!record) throw error(404, 'Record not found on this account.');
	const existing = await sfExisting(SF_OBJECT[kind], [record.sfdcId]);
	let store: StoreExtra | null = null;
	if (kind === 'store') {
		const s = (await listAccountStores(accountId)).find((x) => x.id === id);
		const [full] = await sql<{ business_name: string | null; seller_primary_email: string | null; description: string | null; created_at: Date }[]>`
			SELECT business_name, seller_primary_email, description, created_at FROM stores WHERE id = ${id} AND account_id = ${accountId}`;
		const docs = await sql<{ kind: 'store' | 'case'; id: string; original_name: string; mime_type: string | null; size_bytes: string; sfdc_case_id: string | null; created_at: Date }[]>`
			SELECT 'store' AS kind, d.id, d.original_name, d.mime_type, d.size_bytes::text AS size_bytes, NULL::text AS sfdc_case_id, d.created_at
			FROM store_documents d WHERE d.store_id = ${id}
			UNION ALL
			SELECT 'case', d.id, d.original_name, d.mime_type, d.size_bytes::text, d.sfdc_case_id, d.created_at
			FROM case_documents d WHERE d.store_id = ${id}
			ORDER BY created_at DESC LIMIT 200`;
		let cases: { id: string; number: string; service: string; status: string; priority: string | null; opened: string; modified: string }[] = [];
		let casesError: string | null = null;
		if (record.sfdcId) {
			const res = await listCasesForStore(record.sfdcId, { accountId });
			if (res.ok) cases = res.cases.map((c) => ({ id: c.Id, number: c.CaseNumber, service: c.recordTypeName ?? c.Subject ?? '—', status: c.Status, priority: c.Priority, opened: c.CreatedDate, modified: c.LastModifiedDate }));
			else casesError = res.error;
		}
		if (s) {
			store = {
				name: s.name, marketplaces: s.marketplaces, country: s.country, sellerId: s.seller_id, storeEmail: s.store_email,
				businessName: full?.business_name ?? null, sellerPrimaryEmail: full?.seller_primary_email ?? null, description: full?.description ?? null,
				createdAt: full?.created_at?.toISOString() ?? s.created_at.toISOString(),
				pocName: s.poc_name, pocEmail: s.poc_email, spapiStatus: s.spapi_status,
				spapiConnectedAt: s.spapi_connected_at?.toISOString() ?? null, spapiLastError: s.spapi_last_error,
				cases, casesError,
				docs: docs.map((d) => ({ ...d, created_at: d.created_at.toISOString() }))
			};
		}
	}
	const sfObject = SF_OBJECT[kind];
	let contract: Awaited<ReturnType<typeof accountContracts>>['contracts'][number] | null = null;
	if (kind === 'contract') contract = (await accountContracts(accountId)).contracts.find((c) => c.id === id) ?? null;
	const groups = buildDetailGroups(kind, record, {
		stripePi: stripeUrl('payment', contract?.stripePi ?? (record.raw.stripe_payment_intent_id as string | null)),
		stripeSub: stripeUrl('subscription', record.raw.stripe_subscription_id as string | null)
	});
	return {
		groups,
		sfObject,
		sfUrl: await salesforceUrl(sfObject, record.sfdcId),
		startEditing: event.url.searchParams.get('edit') === '1',
		contract: contract && {
			...contract,
			stripePiUrl: stripeUrl('payment', contract.stripePi),
			stripeSubUrl: stripeUrl('subscription', contract.stripeSub),
			payments: await Promise.all(contract.payments.map(async (p) => ({ ...p, sfUrl: await salesforceUrl('Payment__c', p.sfId), stripeUrl: stripeUrl('payment', p.stripePi) })))
		},
		store,
		record,
		sfState: sfState(record.sfdcId, existing),
		canEdit: roleHas(staff.role, 'accounts.update') && record.editable.length > 0,
		canSync: roleHas(staff.role, 'accounts.update'),
		canDelete: roleHas(staff.role, 'accounts.delete'),
		canManageUsers: roleHas(staff.role, 'users.manage'),
		userActive: kind === 'user' ? record.raw.is_active === true : false,
		userIsStaff: kind === 'user' ? await isStaffUser(id) : false
	};
};

async function isStaffUser(userId: string): Promise<boolean> {
	const [r] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM platform_staff WHERE user_id = ${userId} AND is_active`;
	return r.n > 0;
}

export const actions: Actions = {
	/** Reset password by emailing the user a one-hour link; they get a confirmation email once they set it. */
	reset: async (event) => {
		const { staff, accountId } = await workspace(event, 'users.manage');
		const { kind, id } = parse(event.params);
		if (kind !== 'user') return fail(400, { error: 'Only users have passwords.' });
		const d = await event.request.formData();
		try {
			const r = await initiatePasswordReset({ actor: auditActor(staff), ip: clientIp(event), origin: event.url.origin }, accountId, id, String(d.get('reason') ?? ''), String(d.get('confirm') ?? ''));
			return { ok: r.message };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message });
			throw e;
		}
	},
	/** Reset password with a one-time temporary password (shown once); the user is notified by email. */
	temp: async (event) => {
		const { staff, accountId } = await workspace(event, 'users.manage');
		const { kind, id } = parse(event.params);
		if (kind !== 'user') return fail(400, { error: 'Only users have passwords.' });
		const d = await event.request.formData();
		try {
			const r = await setTemporaryPassword({ actor: auditActor(staff), ip: clientIp(event) }, accountId, id, String(d.get('reason') ?? ''), String(d.get('confirm') ?? ''));
			return { ok: r.message, tempPassword: r.tempPassword };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message });
			throw e;
		}
	},
	resync: resyncAction,
	update: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.update');
		const { kind, id } = parse(event.params);
		const d = await event.request.formData();
		const input: Record<string, string> = {};
		for (const [k, v] of d.entries()) if (typeof v === 'string' && k !== 'version') input[k] = v;
		try {
			return { ok: await updateRecord({ actor: auditActor(staff), ip: clientIp(event) }, accountId, kind, id, input) };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message });
			throw e;
		}
	},
	delete: async (event) => {
		const { staff, accountId } = await workspace(event, 'accounts.delete', { freshMfa: true });
		const { kind, id } = parse(event.params);
		const d = await event.request.formData();
		try {
			await deleteRecord({ actor: auditActor(staff), ip: clientIp(event) }, accountId, kind, id, String(d.get('reason') ?? ''), String(d.get('confirm') ?? ''));
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { error: e.message, deleteError: true as const });
			throw e;
		}
		const tab = kind === 'user' ? 'users' : kind === 'store' ? 'stores' : 'billing/contracts';
		throw redirect(303, `/admin/accounts/${accountId}/${tab}?deleted=1`);
	}
};
