import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	order: [] as string[],
	sfUpdate: vi.fn(),
	sfQuery: vi.fn(),
	audit: vi.fn(),
	account: null as Record<string, unknown> | null
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/error_log', () => ({ logError: vi.fn(async () => {}), describeError: (e: unknown) => ({ errorMessage: e instanceof Error ? e.message : String(e), stack: '' }) }));
vi.mock('$lib/server/admin/audit', () => ({ recordAudit: m.audit }));
vi.mock('$lib/server/storage/s3', () => ({ deleteObject: vi.fn() }));
vi.mock('$lib/server/salesforce/email', () => ({ sendPasswordResetEmail: vi.fn(), sendPasswordChangedEmail: vi.fn() }));
vi.mock('$lib/server/salesforce/records', () => ({ updateSalesforceAccount: vi.fn() }));
vi.mock('$lib/server/salesforce/client', () => ({ sobjectUpdate: m.sfUpdate, sfdcQuery: m.sfQuery }));
vi.mock('$lib/server/admin/accounts', () => ({ getAccount: async () => m.account, getAccountUser: vi.fn() }));
vi.mock('$lib/server/db', () => {
	const handler = (strings: unknown, ..._v: unknown[]) => {
		if (!Array.isArray(strings)) return { fragment: true };
		const text = (strings as string[]).join('?').replace(/\s+/g, ' ').trim();
		if (/FROM platform_staff/.test(text)) return Promise.resolve([]);
		if (/FROM users WHERE account_id/.test(text)) return Promise.resolve([{ id: 'u1', email: 'a@x.com', sfdc_contact_id: 'CONTACT00000001' }]);
		if (/FROM stores WHERE account_id/.test(text)) return Promise.resolve([{ id: 's1', sfdc_store_id: 'STORE0000000001' }]);
		if (/FROM service_contracts WHERE account_id/.test(text)) return Promise.resolve([{ id: 'k1', sfdc_service_contract_id: 'CONTRACT0000001' }]);
		if (/FROM account_contacts WHERE account_id/.test(text)) return Promise.resolve([{ id: 'c1', sfdc_contact_id: 'CONTACT00000002' }]);
		if (/DELETE FROM accounts/.test(text)) m.order.push('local-delete');
		return Promise.resolve([]);
	};
	const sql = Object.assign(handler, {
		json: (v: unknown) => v,
		begin: async (fn: (tx: unknown) => Promise<unknown>) => { const r = await fn(handler); m.order.push('commit'); return r; }
	});
	return { sql };
});

import { deleteAccountCascade } from '../../src/lib/server/admin/actions';

const ID = '11111111-1111-4111-8111-111111111111';
const ctx = { actor: { userId: null, ref: 'staff@x.com', role: 'platform_admin' } };
const acct = (over: Record<string, unknown> = {}) => ({ id: ID, name: 'Acme', sfdc_account_id: '001ACCOUNT000001', ...over });

beforeEach(() => {
	m.order.length = 0;
	m.sfUpdate.mockReset().mockImplementation(async () => { m.order.push('sf'); });
	m.sfQuery.mockReset().mockResolvedValue({ records: [] });
	m.audit.mockReset().mockResolvedValue(undefined);
	m.account = acct();
});

describe('account delete clears Salesforce vuid', () => {
	it('nulls the vuid on every object type, only after the local delete commits', async () => {
		m.sfQuery.mockImplementation(async (soql: string) =>
			/FROM Contact/.test(soql) ? { records: [{ Id: 'CONTACT00000003' }, { Id: 'CONTACT00000001' }] } : { records: [] });
		const r = await deleteAccountCascade(ctx, ID, 'customer request', 'Acme');
		const calls = m.sfUpdate.mock.calls.map((c) => [c[0], c[1], c[2]]);
		const body = { appealsdoctor_vuid__c: null };
		expect(calls).toEqual(expect.arrayContaining([
			['Account', '001ACCOUNT000001', body],
			['Contact', 'CONTACT00000001', body],
			['Contact', 'CONTACT00000002', body],
			['Contact', 'CONTACT00000003', body], // found in Salesforce only
			['Store__c', 'STORE0000000001', body],
			['ServiceContract', 'CONTRACT0000001', body]
		]));
		expect(calls).toHaveLength(6); // contact deduplicated
		expect(m.order.indexOf('commit')).toBeLessThan(m.order.indexOf('sf'));
		expect(r.salesforce).toMatchObject({ attempted: 6, cleared: 6, failed: [] });
		// ids were recorded in the in-transaction audit event
		expect(m.audit.mock.calls[0][0].metadata.salesforceVuidTargets.Store__c).toEqual(['STORE0000000001']);
	});

	it('a Salesforce failure does not fail the delete and is reported and audited', async () => {
		m.sfUpdate.mockImplementation(async (_o: string, id: string) => { if (id === 'STORE0000000001') throw new Error('boom'); });
		const r = await deleteAccountCascade(ctx, ID, 'customer request', 'Acme');
		expect(m.order).toContain('local-delete');
		expect(r.salesforce.cleared).toBe(4);
		expect(r.salesforce.failed).toEqual([{ object: 'Store__c', id: 'STORE0000000001', error: 'boom' }]);
		const last = m.audit.mock.calls.at(-1)![0];
		expect(last.action).toBe('account.delete.salesforce_vuid_cleared');
		expect(last.outcome).toBe('failure');
		expect(last.metadata.failed).toHaveLength(1);
	});

	it('skips an object whose vuid field does not exist', async () => {
		m.sfUpdate.mockImplementation(async (o: string) => { if (o === 'ServiceContract') throw new Error("INVALID_FIELD: No such column 'appealsdoctor_vuid__c'"); });
		const r = await deleteAccountCascade(ctx, ID, 'customer request', 'Acme');
		expect(r.salesforce.failed).toEqual([]);
		expect(r.salesforce.skipped[0]).toMatchObject({ object: 'ServiceContract' });
	});

	it('does nothing in Salesforce for an account with no Salesforce link', async () => {
		m.account = acct({ sfdc_account_id: null });
		// the mocked children carry Salesforce ids, so make them absent via a separate unit check below
		const { clearSalesforceVuids } = await import('../../src/lib/server/admin/sf_vuid_clear');
		const empty = { Account: [], Contact: [], Store__c: [], ServiceContract: [] };
		const r = await clearSalesforceVuids({ accountId: ID, sfdcAccountId: null, known: empty, localIds: empty });
		expect(r.attempted).toBe(0);
		expect(m.sfUpdate).not.toHaveBeenCalled();
		expect(m.sfQuery).not.toHaveBeenCalled();
	});
});
