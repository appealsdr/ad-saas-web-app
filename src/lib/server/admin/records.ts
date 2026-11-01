/**
 * Generic admin record view / edit / delete for the records an account owns
 * (users, stores, service contracts). Secrets never leave the server: columns
 * whose names look sensitive are dropped from the extended view.
 *
 * Deletes are LOCAL only — the linked Salesforce record is left untouched and
 * the result says so. Edits are local; "Sync to Salesforce" pushes them.
 */
import { sql } from '../db';
import { recordAudit, type AuditActor } from './audit';
import { ActionError, requireReason } from './actions';
import { deleteObject } from '../storage/s3';

export type RecordKind = 'user' | 'store' | 'contract';
export const RECORD_KINDS: RecordKind[] = ['user', 'store', 'contract'];

const TABLE: Record<RecordKind, string> = { user: 'users', store: 'stores', contract: 'service_contracts' };
const SF_COL: Record<RecordKind, string> = { user: 'sfdc_contact_id', store: 'sfdc_store_id', contract: 'sfdc_service_contract_id' };
export const SF_OBJECT = { user: 'Contact', store: 'Store__c', contract: 'ServiceContract' } as const;

const SENSITIVE = /(password|hash|token|secret|totp|mfa|encrypt|private|salt|cipher)/i;

export const EDITABLE: Record<RecordKind, { name: string; label: string; type?: string }[]> = {
	user: [{ name: 'display_name', label: 'Display name' }],
	store: [
		{ name: 'name', label: 'Store name' }, { name: 'marketplaces', label: 'Marketplaces (; separated)' },
		{ name: 'country', label: 'Country' }, { name: 'seller_id', label: 'Seller ID' },
		{ name: 'business_name', label: 'Legal business name' }, { name: 'seller_primary_email', label: 'Amazon notification email', type: 'email' },
		{ name: 'store_email', label: 'Store contact email', type: 'email' }, { name: 'description', label: 'Description' }
	],
	contract: [
		{ name: 'status', label: 'Status' }, { name: 'payment_status', label: 'Payment status' },
		{ name: 'start_date', label: 'Start date', type: 'date' }, { name: 'end_date', label: 'End date', type: 'date' }
	]
};

export type Own = 'sf' | 'local' | 'sys';
export interface FieldSpec { key: string; label: string; own: Own; api?: string; mono?: boolean; note?: string; money?: boolean; link?: 'stripe-pi' | 'stripe-sub' }
export interface Group { title: string; fields: FieldSpec[] }

/** Where every field lives. `api` is the Salesforce field it is pushed to (own = 'sf'). */
export const SPEC: Record<RecordKind, Group[]> = {
	user: [
		{ title: 'Identity', fields: [
			{ key: 'display_name', label: 'Display name', own: 'sf', api: 'Contact.FirstName / LastName' },
			{ key: 'email', label: 'Email', own: 'local', note: 'sign-in email' },
			{ key: 'role', label: 'Customer role', own: 'local' },
			{ key: 'is_active', label: 'Active', own: 'local' },
			{ key: 'must_reset_password', label: 'Must reset password', own: 'local' },
			{ key: 'last_login_at', label: 'Last login', own: 'local' },
			{ key: 'created_at', label: 'Created', own: 'local' }
		] },
		{ title: 'IDs & system', fields: [
			{ key: 'id', label: 'Local ID', own: 'local', mono: true },
			{ key: 'sfdc_contact_id', label: 'Salesforce contact', own: 'local', mono: true, note: 'the link to Salesforce' },
			{ key: 'account_id', label: 'Account ID', own: 'local', mono: true }
		] }
	],
	store: [
		{ title: 'Store', fields: [
			{ key: 'name', label: 'Store name', own: 'sf', api: 'Store__c.Name' },
			{ key: 'marketplaces', label: 'Marketplaces', own: 'sf', api: 'Store__c.Marketplaces__c' },
			{ key: 'country', label: 'Country', own: 'sf', api: 'Store__c.Country__c' },
			{ key: 'seller_id', label: 'Seller ID', own: 'sf', api: 'Store__c.Seller_ID__c', mono: true },
			{ key: 'business_name', label: 'Legal business name', own: 'sf', api: 'Store__c.Business_Name__c' },
			{ key: 'seller_primary_email', label: 'Amazon notification email', own: 'sf', api: 'Store__c.Seller_Account_Primary_Email__c' },
			{ key: 'store_email', label: 'Store contact email', own: 'sf', api: 'Store__c.Store_Email__c' },
			{ key: 'description', label: 'Description', own: 'sf', api: 'Store__c.Description__c' }
		] },
		{ title: 'Amazon connection (persisted state)', fields: [
			{ key: 'spapi_status', label: 'SP-API status', own: 'local' },
			{ key: 'spapi_connected_at', label: 'Connected at', own: 'local' },
			{ key: 'spapi_last_error', label: 'Last error', own: 'local' }
		] },
		{ title: 'IDs & system', fields: [
			{ key: 'id', label: 'Local ID', own: 'local', mono: true },
			{ key: 'sfdc_store_id', label: 'Salesforce store', own: 'local', mono: true, note: 'the link to Salesforce' },
			{ key: 'created_at', label: 'Created', own: 'local' }
		] }
	],
	contract: [
		{ title: 'Contract', fields: [
			{ key: 'kind', label: 'Type', own: 'local' },
			{ key: 'status', label: 'Status', own: 'sf', api: 'ServiceContract.Status', note: 'Only “cancelled” is pushed' },
			{ key: 'payment_status', label: 'Payment status', own: 'sf', api: 'ServiceContract.Payment_Status__c' },
			{ key: 'start_date', label: 'Start date', own: 'sf', api: 'ServiceContract.StartDate' },
			{ key: 'end_date', label: 'End date', own: 'sf', api: 'ServiceContract.EndDate' },
			{ key: 'term_months', label: 'Term (months)', own: 'local' },
			{ key: 'amount_cents', label: 'Amount', own: 'local', money: true },
			{ key: 'paid_at', label: 'Paid at', own: 'local' },
			{ key: 'cancel_requested_at', label: 'Cancellation requested', own: 'local', note: 'Stripe subscription cancelled — active until the end date' }
		] },
		{ title: 'Stripe', fields: [
			{ key: 'stripe_payment_intent_id', label: 'Payment intent', own: 'local', mono: true, link: 'stripe-pi' },
			{ key: 'stripe_subscription_id', label: 'Subscription', own: 'local', mono: true, link: 'stripe-sub' }
		] },
		{ title: 'IDs & system', fields: [
			{ key: 'id', label: 'Local ID', own: 'local', mono: true },
			{ key: 'sfdc_service_contract_id', label: 'Salesforce contract', own: 'local', mono: true, note: 'the link to Salesforce' },
			{ key: 'sync_status', label: 'Sync status', own: 'local' },
			{ key: 'sync_error', label: 'Sync error', own: 'local' },
			{ key: 'created_at', label: 'Created', own: 'local' }
		] }
	]
};

export interface RecordView {
	kind: RecordKind;
	id: string;
	title: string;
	sfdcId: string | null;
	fields: { key: string; value: string }[];
	raw: Record<string, unknown>;
	editable: { name: string; label: string; type?: string; value: string }[];
	related: { label: string; value: string }[];
	deleteConfirm: string;
}

const show = (v: unknown): string => {
	if (v === null || v === undefined || v === '') return '—';
	if (v instanceof Date) return v.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
	if (typeof v === 'object') return JSON.stringify(v);
	return String(v);
};

export async function getRecord(accountId: string, kind: RecordKind, id: string): Promise<RecordView | null> {
	const [row] = await sql<Record<string, unknown>[]>`
		SELECT to_jsonb(t) AS j FROM ${sql(TABLE[kind])} t WHERE t.id = ${id} AND t.account_id = ${accountId}
	`.then((r) => r.map((x) => x.j as Record<string, unknown>));
	if (!row) return null;
	const fields = Object.entries(row)
		.filter(([k]) => !SENSITIVE.test(k))
		.map(([key, v]) => ({ key, value: show(v) }));

	let title = String(row.name ?? row.display_name ?? row.email ?? row.stripe_payment_intent_id ?? id);
	let deleteConfirm = title;
	const related: { label: string; value: string }[] = [];
	if (kind === 'user') {
		deleteConfirm = String(row.email);
		title = `${row.display_name ?? row.email}`;
		const [c] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions WHERE user_id = ${id}`;
		related.push({ label: 'Active sessions', value: String(c.n) });
	} else if (kind === 'store') {
		const [c] = await sql<{ d: number; k: number; cs: number }[]>`
			SELECT (SELECT count(*) FROM store_documents WHERE store_id = ${id})::int AS d,
			       (SELECT count(*) FROM case_documents WHERE store_id = ${id})::int AS k,
			       (SELECT count(*) FROM service_contracts WHERE store_id = ${id})::int AS cs`;
		related.push({ label: 'Store documents', value: String(c.d) }, { label: 'Case documents', value: String(c.k) }, { label: 'Service contracts', value: String(c.cs) });
	} else {
		deleteConfirm = String(row.stripe_payment_intent_id ?? id);
		title = `Service contract ${String(row.stripe_payment_intent_id ?? id)}`;
		const lines = await sql<{ product_name: string; quantity: number; unit_price: string }[]>`
			SELECT product_name, quantity, unit_price FROM service_contract_line_items WHERE service_contract_id = ${id} ORDER BY created_at`;
		related.push(...lines.map((l) => ({ label: 'Line item', value: `${l.product_name} × ${l.quantity} @ $${l.unit_price}` })));
	}
	return {
		kind, id, title,
		sfdcId: (row[SF_COL[kind]] as string | null) ?? null,
		fields,
		raw: Object.fromEntries(Object.entries(row).filter(([k]) => !SENSITIVE.test(k))),
		editable: EDITABLE[kind].map((f) => {
			const v = row[f.name] == null ? '' : String(row[f.name]);
			return { ...f, value: f.type === 'date' ? v.slice(0, 10) : v };
		}),
		related,
		deleteConfirm
	};
}

interface Ctx { actor: AuditActor; ip?: string | null }

export async function updateRecord(ctx: Ctx, accountId: string, kind: RecordKind, id: string, input: Record<string, string>): Promise<string> {
	const spec = EDITABLE[kind];
	if (!spec.length) throw new ActionError('This record type is read-only.', 422);
	const cur = await getRecord(accountId, kind, id);
	if (!cur) throw new ActionError('Record not found on this account.', 404);
	const changes: Record<string, string | null> = {};
	for (const f of spec) {
		if (!(f.name in input)) continue;
		const v = input[f.name].trim().slice(0, 1000);
		if (f.type === 'date' && v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new ActionError(`${f.label} must be a date (YYYY-MM-DD).`, 422);
		if ((f.name === 'name' || f.name === 'display_name') && !v) throw new ActionError(`${f.label} is required.`, 422);
		if (v !== (cur.editable.find((e) => e.name === f.name)?.value ?? '')) changes[f.name] = v || null;
	}
	const keys = Object.keys(changes);
	if (!keys.length) return 'No changes to save.';
	await sql.begin(async (tx) => {
		for (const k of keys) {
			await tx`UPDATE ${sql(TABLE[kind])} SET ${sql(k)} = ${changes[k]} WHERE id = ${id} AND account_id = ${accountId}`;
		}
		await recordAudit({ actor: ctx.actor, action: `${kind}.update`, targetType: kind, targetId: id, targetAccountId: accountId, outcome: 'success', ip: ctx.ip, metadata: { fields: keys } }, tx);
	});
	return `Saved locally (${keys.join(', ')}). Use "Sync to Salesforce" to push the change.`;
}

export async function deleteRecord(ctx: Ctx, accountId: string, kind: RecordKind, id: string, reason: string | null, confirm: string | null): Promise<string> {
	const why = requireReason(reason);
	const rec = await getRecord(accountId, kind, id);
	if (!rec) throw new ActionError('Record not found on this account.', 404);
	if ((confirm ?? '').trim().toLowerCase() !== rec.deleteConfirm.trim().toLowerCase()) {
		throw new ActionError(`Confirmation did not match. Type "${rec.deleteConfirm}" to confirm.`, 422);
	}
	let keys: string[] = [];
	try {
		await sql.begin(async (tx) => {
			if (kind === 'user') {
				const [u] = await tx<{ role: string; staff: boolean }[]>`
					SELECT u.role, (ps.user_id IS NOT NULL) AS staff FROM users u LEFT JOIN platform_staff ps ON ps.user_id = u.id WHERE u.id = ${id}`;
				if (u?.role === 'owner') throw new ActionError('The account owner cannot be deleted. Delete the whole account instead.', 409);
				if (u?.staff) throw new ActionError('Platform staff cannot be deleted here. Remove their staff membership first.', 409);
				await tx`DELETE FROM sessions WHERE user_id = ${id}`;
				await tx`DELETE FROM users WHERE id = ${id} AND account_id = ${accountId}`;
			} else if (kind === 'store') {
				const docs = await tx<{ k: string | null }[]>`
					SELECT s3_key AS k FROM store_documents WHERE store_id = ${id} UNION ALL SELECT s3_key FROM case_documents WHERE store_id = ${id}`;
				keys = docs.map((d) => d.k).filter((k): k is string => !!k);
				await tx`DELETE FROM store_documents WHERE store_id = ${id}`;
				await tx`DELETE FROM case_documents WHERE store_id = ${id}`;
				await tx`DELETE FROM stores WHERE id = ${id} AND account_id = ${accountId}`;
			} else {
				await tx`UPDATE accounts SET active_subscription_contract_id = NULL WHERE id = ${accountId} AND active_subscription_contract_id = ${id}`;
				await tx`UPDATE stores SET active_service_contract_id = NULL WHERE account_id = ${accountId} AND active_service_contract_id = ${id}`;
				await tx`DELETE FROM service_contract_line_items WHERE service_contract_id = ${id}`;
				await tx`DELETE FROM service_contracts WHERE id = ${id} AND account_id = ${accountId}`;
			}
			await recordAudit({ actor: ctx.actor, action: `${kind}.delete`, targetType: kind, targetId: id, targetAccountId: accountId, outcome: 'success', reason: why, ip: ctx.ip, metadata: { label: rec.title, sfdcId: rec.sfdcId, salesforceUntouched: true } }, tx);
		});
	} catch (e) {
		if (e instanceof ActionError) throw e;
		if ((e as { code?: string })?.code === '23503') throw new ActionError('Other records still depend on this one, so it cannot be deleted.', 409);
		throw e;
	}
	await Promise.all(keys.map((k) => deleteObject(k).catch(() => undefined)));
	return `${rec.title} deleted locally.${rec.sfdcId ? ' The linked Salesforce record was not changed.' : ''}`;
}

// ─── Detail rows (Account-overview layout: Field / Value / Synced to SF / API name / Source) ──

export interface DetailRow {
	key: string; label: string; value: string; own: Own; api?: string; mono?: boolean; note?: string;
	href?: string; editable?: boolean; inputType?: string; inputValue?: string;
}
export interface DetailGroup { title: string; rows: DetailRow[] }

function display(v: unknown, f: FieldSpec): string {
	if (v === null || v === undefined || v === '') return '—';
	if (typeof v === 'boolean') return v ? 'Yes' : 'No';
	if (f.money) return `$${(Number(v) / 100).toFixed(2)}`;
	const s = String(v);
	return /^\d{4}-\d{2}-\d{2}T/.test(s) ? s.replace('T', ' ').slice(0, 19) + ' UTC' : s;
}

export function buildDetailGroups(kind: RecordKind, rec: RecordView, links: { stripePi?: string | null; stripeSub?: string | null } = {}): DetailGroup[] {
	const edit = new Map(rec.editable.map((e) => [e.name, e]));
	return SPEC[kind].map((g) => ({
		title: g.title,
		rows: g.fields.map((f): DetailRow => {
			const e = edit.get(f.key);
			return {
				key: f.key, label: f.label, own: f.own, api: f.api, mono: f.mono, note: f.note,
				value: display(rec.raw[f.key], f),
				href: f.link === 'stripe-pi' ? links.stripePi ?? undefined : f.link === 'stripe-sub' ? links.stripeSub ?? undefined : undefined,
				editable: !!e, inputType: e?.type ?? 'text', inputValue: e?.value
			};
		})
	}));
}
