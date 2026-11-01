import type { PageServerLoad } from './$types';
import { requireStaff } from '$lib/server/admin/guard';
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
		readerConfigured: readerConfigured()
	};
};
