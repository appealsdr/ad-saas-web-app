import { describe, expect, it } from 'vitest';
import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeUser, uniq } from '../setup/db';
import { buildDetailGroups, deleteRecord, getRecord, updateRecord } from '$lib/server/admin/records';
import { accountContracts } from '$lib/server/admin/billing';

const d = describe.skipIf(!hasDb);
const actor = { userId: null, ref: 'test@example.test', role: 'platform_admin' };

async function makeContract(accountId: string, over: Partial<{ pi: string; sf: string | null }> = {}) {
	const pi = over.pi ?? `pi_${uniq()}`;
	const [c] = await sql<{ id: string }[]>`
		INSERT INTO service_contracts (account_id, stripe_payment_intent_id, amount_cents, currency, paid_at, start_date, end_date, sfdc_service_contract_id)
		VALUES (${accountId}, ${pi}, 12345, 'usd', now(), '2026-01-01', '2026-04-01', ${over.sf ?? null}) RETURNING id`;
	await sql`INSERT INTO service_contract_line_items (service_contract_id, product_name, unit_price, quantity, currency)
	          VALUES (${c.id}, 'Listing Reinstatement', 100, 2, 'usd')`;
	return { id: c.id, pi };
}

d('admin record detail', () => {
	it('builds Field / Value / Source rows with Salesforce API names and hides secrets', async () => {
		const A = await makeAccount();
		const u = await makeUser({ accountId: A.id, role: 'owner' });
		const rec = (await getRecord(A.id, 'user', u.id))!;
		const groups = buildDetailGroups('user', rec);
		const flat = groups.flatMap((g) => g.rows);
		expect(flat.find((r) => r.key === 'display_name')).toMatchObject({ own: 'sf', api: 'Contact.FirstName / LastName', editable: true });
		expect(flat.find((r) => r.key === 'email')).toMatchObject({ own: 'local', editable: false });
		expect(Object.keys(rec.raw)).not.toContain('password_hash');
	});

	it('edits contract fields (dates validated), deletes with confirmation, and scopes by account', async () => {
		const A = await makeAccount();
		const B = await makeAccount();
		const k = await makeContract(A.id);

		const msg = await updateRecord({ actor }, A.id, 'contract', k.id, { status: 'cancelled', payment_status: 'Canceled', end_date: '2026-06-30' });
		expect(msg).toMatch(/Saved locally/);
		const rec = (await getRecord(A.id, 'contract', k.id))!;
		expect(rec.raw.status).toBe('cancelled');
		expect(rec.editable.find((e) => e.name === 'end_date')?.value).toBe('2026-06-30');
		await expect(updateRecord({ actor }, A.id, 'contract', k.id, { end_date: 'tomorrow' })).rejects.toThrow(/YYYY-MM-DD/);

		expect(await getRecord(B.id, 'contract', k.id)).toBeNull(); // other account cannot see it
		await expect(deleteRecord({ actor }, A.id, 'contract', k.id, 'cleanup of test data', 'wrong')).rejects.toThrow(/Confirmation did not match/);
		await deleteRecord({ actor }, A.id, 'contract', k.id, 'cleanup of test data', k.pi);
		expect(await getRecord(A.id, 'contract', k.id)).toBeNull();
		const left = await sql`SELECT 1 FROM service_contract_line_items WHERE service_contract_id = ${k.id}`;
		expect(left).toHaveLength(0);
	});

	it('lists contracts with their line items and a synthesised payment when Salesforce has none', async () => {
		const A = await makeAccount();
		const k = await makeContract(A.id);
		const { contracts } = await accountContracts(A.id);
		const c = contracts.find((x) => x.id === k.id)!;
		expect(c.lines).toMatchObject([{ name: 'Listing Reinstatement', qty: 2, unit: 100 }]);
		expect(c.payments).toHaveLength(1);
		expect(c.payments[0]).toMatchObject({ key: `local:${k.id}`, sfId: null, status: 'paid', amount: 123.45, stripePi: k.pi });
	});
});
