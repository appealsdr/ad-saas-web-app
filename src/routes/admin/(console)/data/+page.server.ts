import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { requireStaff, auditActor, clientIp } from '$lib/server/admin/guard';
import { ActionError } from '$lib/server/admin/actions';
import { previewSql, executeSql, WRITABLE_TABLES, MAX_ROWS, type SqlOp } from '$lib/server/admin/data/sql_exec';
import { roleHas } from '$lib/server/admin/permissions';
import { browseTable, listInventory, tableColumns } from '$lib/server/admin/data/browse';
import { readerConfigured } from '$lib/server/admin/data/reader_db';
import { parsePage } from '$lib/server/admin/pagination';

export const load: PageServerLoad = async (event) => {
	const staff = requireStaff(event, 'data.read');
	const inventory = await listInventory();
	const sp = event.url.searchParams;
	const table = inventory.find((t) => t.name === sp.get('table'))?.name ?? inventory[0]?.name ?? '';
	const [columns, result] = await Promise.all([
		tableColumns(table),
		browseTable({
			table,
			page: parsePage(sp.get('page')),
			pageSize: 50,
			sort: sp.get('sort'),
			dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
			filterColumn: sp.get('fcol'),
			filterValue: sp.get('fval')
		})
	]);
	return {
		inventory,
		table,
		columns,
		result,
		page: parsePage(sp.get('page')),
		sort: sp.get('sort') ?? '',
		dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
		fcol: sp.get('fcol') ?? '',
		fval: sp.get('fval') ?? '',
		canQuery: roleHas(staff.role, 'data.query'),
		sqlConsole: { enabled: roleHas(staff.role, 'data.write'), writable: [...WRITABLE_TABLES] as string[], maxRows: MAX_ROWS },
		readerConfigured: readerConfigured()
	};
};

const op = (v: FormDataEntryValue | null): SqlOp => {
	if (v === 'insert' || v === 'update' || v === 'delete') return v;
	throw new ActionError('Choose insert, update or delete.', 400);
};

export const actions: Actions = {
	sqlPreview: async (event) => {
		requireStaff(event, 'data.write');
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
		const staff = requireStaff(event, 'data.write', { freshMfa: true });
		const d = await event.request.formData();
		try {
			const msg = await executeSql({ actor: auditActor(staff), ip: clientIp(event) }, null, op(d.get('op')), String(d.get('table') ?? ''), String(d.get('sql') ?? ''), Number(d.get('expectedRows')), String(d.get('reason') ?? ''));
			return { sqlOk: msg };
		} catch (e) {
			if (e instanceof ActionError) return fail(e.status, { sqlError: e.message });
			throw e;
		}
	}
};
