import type { PageServerLoad } from './$types';
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
	ai_chat_messages: 'Activity',
	sessions: 'Security', password_reset_tokens: 'Security', password_history: 'Security', oauth_accounts: 'Security', spapi_oauth_states: 'Security',
	error_log: 'Logs', activity_log: 'Logs', admin_audit_events: 'Logs'
};

export const load: PageServerLoad = async (event) => {
	const { accountId } = await workspace(event, 'data.read');
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
		ops: OPS, noVal: NOVAL
	};
};
