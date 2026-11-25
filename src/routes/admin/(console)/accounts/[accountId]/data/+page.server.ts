import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { roleHas } from '$lib/server/admin/permissions';
import { auditActor, clientIp } from '$lib/server/admin/guard';
import { ActionError } from '$lib/server/admin/actions';
import { previewSql, executeSql, WRITABLE_TABLES, MAX_ROWS, type SqlOp } from '$lib/server/admin/data/sql_exec';
import { workspace } from '$lib/server/admin/workspace';
import { accountTableCounts, exploreAccountTable } from '$lib/server/admin/data/browse';
import { INVENTORY } from '$lib/server/admin/data/inventory';
import { NOVAL, OPS, parseConds } from '$lib/server/admin/data/filters';
import { parsePage } from '$lib/server/admin/pagination';

const PAGE_SIZE = 25;

const GROUP_ORDER = ['Account', 'Stores & documents', 'Billing', 'Activity', 'Security', 'Logs', 'Other'];
const GROUPS: Record<string, string> = {
	accounts: 'Account', users: 'Account', account_contacts: 'Account',
	stores: 'Stores & documents', store_documents: 'Stores & documents', case_documents: 'Stores & documents',
	service_contracts: 'Billing', service_contract_line_items: 'Billing',
	stripe_payments: 'Billing', salesforce_contracts: 'Billing', salesforce_contract_line_items: 'Billing', salesforce_contract_payments: 'Billing',
	ai_chat_messages: 'Activity',
	sessions: 'Security', password_reset_tokens: 'Security', password_history: 'Security', oauth_accounts: 'Security', spapi_oauth_states: 'Security',
	error_log: 'Logs', activity_log: 'Logs', admin_audit_events: 'Logs'
};

export const load: PageServerLoad = async (event) => {
	const { accountId, staff } = await workspace(event, 'data.read');
	const scoped = INVENTORY.filter((e) => e.view && e.accountScope);
	const globalTables = INVENTORY.filter((e) => !e.accountScope).map((e) => e.name);
	const sp = event.url.searchParams;
	const table = scoped.some((t) => t.name === sp.get('table')) ? (sp.get('table') as string) : scoped[0].name;
	const page = parsePage(sp.get('page'));
	const dir = sp.get('dir') === 'asc' ? 'asc' : 'desc';
	const conds = parseConds(sp.get('f'));
	const logic = (sp.get('logic') ?? '').slice(0, 200);
	const search = (sp.get('q') ?? '').slice(0, 200);

	const [counts, result] = await Promise.all([
		accountTableCounts(accountId, scoped.map((t) => t.name)),
		exploreAccountTable({ table, accountId, page, pageSize: PAGE_SIZE, sort: sp.get('sort'), dir, search, conds, logic })
	]);

	const groups = [...new Set(scoped.map((t) => GROUPS[t.name] ?? 'Other'))]
		.sort((a, b) => GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b))
		.map((title) => ({ title, items: scoped.filter((t) => (GROUPS[t.name] ?? 'Other') === title).map((t) => ({ name: t.name, count: counts[t.name] ?? 0 })) }));

	return {
		groups, tableCount: scoped.length, globalTables, table, result, page, pageSize: PAGE_SIZE,
		query: { sort: sp.get('sort') ?? '', dir, q: search, conds, logic },
		ops: OPS, noVal: NOVAL,
		sqlConsole: { enabled: roleHas(staff.role, 'data.write'), writable: [...WRITABLE_TABLES], maxRows: MAX_ROWS }
	};
};

const op = (v: FormDataEntryValue | null): SqlOp => {
	if (v === 'insert' || v === 'update' || v === 'delete') return v;
	throw new ActionError('Choose insert, update or delete.', 400);
};

export const actions: Actions = {
	sqlPreview: async (event) => {
		await workspace(event, 'data.write');
		const d = await event.request.formData();
		try {
			const r = await previewSql(op(d.get('op')), String(d.get('table') ?? ''), String(d.get('sql') ?? ''));
			return { preview: { rows: r.rows, sql: r.stmt, op: String(d.get('op')), table: String(d.get('table')) } };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { sqlError: e.message });
			throw e;
		}
	},
	sqlRun: async (event) => {
		const { staff, accountId } = await workspace(event, 'data.write', { freshMfa: true });
		const d = await event.request.formData();
		try {
			const msg = await executeSql({ actor: auditActor(staff), ip: clientIp(event) }, accountId, op(d.get('op')), String(d.get('table') ?? ''), String(d.get('sql') ?? ''), Number(d.get('expectedRows')), String(d.get('reason') ?? ''));
			return { sqlOk: msg };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { sqlError: e.message });
			throw e;
		}
	}
};
