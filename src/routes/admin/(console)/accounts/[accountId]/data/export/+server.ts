/**
 * GET /admin/accounts/:accountId/data/export?table=…&q=…&f=…&logic=…&sort=…&dir=…
 *   (no extra flag)  → CSV of the rows matching search + filters + sort (max 50,000)
 *   count=1          → JSON { total, capped, error } for the filter dialog's live count
 * Same scope, validation and column projection as the table view; exports are audited.
 */
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { workspace } from '$lib/server/admin/workspace';
import { countAccountTable, exportAccountRows } from '$lib/server/admin/data/browse';
import { INVENTORY } from '$lib/server/admin/data/inventory';
import { parseConds } from '$lib/server/admin/data/filters';
import { auditActor, clientIp } from '$lib/server/admin/guard';
import { recordAudit } from '$lib/server/admin/audit';

const csvCell = (v: unknown) => {
	if (v === null || v === undefined) return '';
	let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
	if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
	return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

export const GET: RequestHandler = async (event) => {
	const { staff, accountId } = await workspace(event, 'data.read');
	const sp = event.url.searchParams;
	const table = sp.get('table') ?? '';
	if (!INVENTORY.some((e) => e.name === table && e.view && e.accountScope)) throw error(404, 'Unknown table.');
	const params = {
		table, accountId, page: 1, pageSize: 25,
		sort: sp.get('sort'), dir: (sp.get('dir') === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc',
		search: (sp.get('q') ?? '').slice(0, 200), conds: parseConds(sp.get('f')), logic: (sp.get('logic') ?? '').slice(0, 200)
	};

	if (sp.get('count')) return json(await countAccountTable(params));

	const out = await exportAccountRows(params);
	if (!out) throw error(400, 'Invalid filters.');
	await recordAudit({
		actor: auditActor(staff), action: 'data.export', targetType: 'table', targetId: table, targetAccountId: accountId,
		outcome: 'success', ip: clientIp(event), metadata: { rows: out.rows.length, filtered: params.conds.length > 0 || !!params.search }
	});
	const csv = [out.columns.join(','), ...out.rows.map((r) => out.columns.map((c) => csvCell(r[c])).join(','))].join('\r\n');
	return new Response(csv, {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="${table}${params.conds.length || params.search ? '_filtered' : ''}.csv"`,
			'cache-control': 'no-store',
			'x-content-type-options': 'nosniff'
		}
	});
};
