import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	rows: [] as unknown[][],       // queued results for plain sql`` calls, in order
	begin: vi.fn(),
	sfAccount: vi.fn(),
	sfContact: vi.fn(),
	sfQuery: vi.fn(),
	audit: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db', () => ({
	sql: Object.assign(() => Promise.resolve(m.rows.shift() ?? []), { begin: m.begin })
}));
vi.mock('$lib/server/salesforce/client', () => ({ sfdcQuery: m.sfQuery }));
vi.mock('$lib/server/salesforce/records', () => ({
	fetchSalesforceAccount: m.sfAccount,
	fetchSalesforceContact: m.sfContact,
	updateSalesforceAccount: async () => ({ ok: true }),
	updateSalesforceContact: async () => ({ ok: true })
}));
vi.mock('$lib/server/salesforce/stores', () => ({ updateSalesforceStore: async () => ({ ok: true }) }));
vi.mock('$lib/server/auth/password', () => ({ hashPassword: async () => 'hash' }));
vi.mock('$lib/server/auth/temp_password', () => ({ generateTempPassword: () => 'Temp-Pass-1' }));
vi.mock('$lib/server/storage/s3-paths', () => ({ ensureAccountFolders: async () => {} }));
vi.mock('$lib/server/account/contacts', () => ({ ensureOwnerAccountContact: async () => null }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: () => ({ errorMessage: 'x', stack: '' }) }));
vi.mock('$lib/server/admin/audit', () => ({ recordAudit: m.audit }));

import { buildCandidates, attachMatches, provisionFromSalesforce } from '../../src/lib/server/admin/provision';
import { findDuplicateGroups, hostKey, type AccountLite } from '../../src/lib/server/admin/merge_candidates';
import { ActionError } from '../../src/lib/server/admin/actions';

const SF_A = '001Vp00001PqAFiIAN';
const SF_C = '003Vp00001Flb4bIAB';
const ctx = { actor: { userId: null, ref: 'staff@x.com', role: 'platform_admin' } };

const contract = (accountId: string, name = 'Acme') => ({
	Id: '800' + accountId.slice(3), Name: `${name} contract`, ContractNumber: '1', StartDate: null, EndDate: null, AccountId: accountId,
	Account: { Name: name, Phone: null, Website: null, Primary_Email__c: 'a@acme.com' }
});

describe('buildCandidates', () => {
	it('groups contracts by account and skips accounts already linked (15 or 18 char ids)', () => {
		const out = buildCandidates(
			[contract(SF_A), contract(SF_A), contract('001Vp00001Q2mpDIAR', 'Other')],
			[{ Id: SF_C, FirstName: 'A', LastName: 'B', Email: 'a@acme.com', AccountId: SF_A }],
			[{ Id: 'a0X1', Name: 'Store 1', Account__c: SF_A, Seller_ID__c: 'S1', Marketplaces__c: null }],
			[SF_A.slice(0, 15)]
		);
		expect(out.map((c) => c.name)).toEqual(['Other']);
		const both = buildCandidates([contract(SF_A), contract(SF_A)], [{ Id: SF_C, FirstName: 'A', LastName: 'B', Email: 'a@acme.com', AccountId: SF_A }], [{ Id: 'a0X1', Name: 'Store 1', Account__c: SF_A, Seller_ID__c: null, Marketplaces__c: null }], []);
		expect(both).toHaveLength(1);
		expect(both[0].contracts).toHaveLength(2);
		expect(both[0].contacts).toHaveLength(1);
		expect(both[0].stores).toHaveLength(1);
	});
});

describe('attachMatches', () => {
	it('flags platform accounts with the same email or normalised name, not the one already linked', () => {
		const [cand] = buildCandidates([contract(SF_A, 'Acme LLC')], [], [], []);
		attachMatches([cand], [
			{ id: 'p1', name: 'Other Co', sfdc_account_id: null, emails: ['A@Acme.com'] },
			{ id: 'p2', name: 'ACME, Inc.', sfdc_account_id: null, emails: [] },
			{ id: 'p3', name: 'Unrelated', sfdc_account_id: null, emails: ['z@z.com'] },
			{ id: 'p4', name: 'Acme LLC', sfdc_account_id: SF_A, emails: ['a@acme.com'] }
		]);
		expect(cand.matches.map((x) => [x.accountId, x.reason])).toEqual([['p1', 'email'], ['p2', 'name']]);
	});
});

describe('findDuplicateGroups', () => {
	const acc = (id: string, name: string, emails: string[], website: string | null = null): AccountLite =>
		({ id, name, emails, website, sfdc_account_id: null, user_count: 1, store_count: 0, contract_count: 0, created_at: new Date() });
	it('groups by canonical email, website host and name, reporting each pair once', () => {
		const g = findDuplicateGroups([
			acc('1', 'Acme LLC', ['a.b.c@gmail.com'], 'https://www.acme.com'),
			acc('2', 'Acme Inc', ['abc@gmail.com'], 'acme.com'),
			acc('3', 'Solo', ['solo@x.com'], 'https://gmail.com'),
			acc('4', 'Beta', ['b@b.com'], 'beta.io'),
			acc('5', 'beta', ['c@c.com'], 'other.io')
		]);
		expect(g.map((x) => [x.signal, x.accounts.map((a) => a.id)])).toEqual([['email', ['1', '2']], ['name', ['4', '5']]]);
	});
	it('ignores generic hosts', () => {
		expect(hostKey('https://gmail.com')).toBeNull();
		expect(hostKey('www.Acme.com/x')).toBe('acme.com');
	});
});

describe('provisionFromSalesforce', () => {
	beforeEach(() => {
		m.rows = [];
		m.begin.mockReset();
		m.audit.mockReset();
		m.sfAccount.mockReset().mockResolvedValue({ ok: true, record: { Id: SF_A, Name: 'Acme', Phone: '1', Website: 'acme.com', Primary_Email__c: 'a@acme.com' } });
		m.sfContact.mockReset().mockResolvedValue({ ok: true, record: { Id: SF_C, AccountId: SF_A, FirstName: 'Ann', LastName: 'Lee', Email: 'ann@acme.com', Phone: '2' } });
		m.sfQuery.mockReset().mockResolvedValue({ records: [{ Id: 'a0X1', Name: 'Store 1', Account__c: SF_A, Seller_ID__c: null, Marketplaces__c: null }] });
	});
	const input = { sfdcAccountId: SF_A, sfdcContactId: SF_C, storeIds: ['a0X1'], createLogin: true, reason: 'Client onboarded in Salesforce' };

	it('requires a reason and valid ids before touching anything', async () => {
		await expect(provisionFromSalesforce(ctx, { ...input, reason: 'x' })).rejects.toBeInstanceOf(ActionError);
		await expect(provisionFromSalesforce(ctx, { ...input, sfdcAccountId: 'bad' })).rejects.toMatchObject({ status: 422 });
		expect(m.sfAccount).not.toHaveBeenCalled();
		expect(m.begin).not.toHaveBeenCalled();
	});
	it('refuses a store that is not under the Salesforce account', async () => {
		await expect(provisionFromSalesforce(ctx, { ...input, storeIds: ['a0XOTHER'] })).rejects.toMatchObject({ status: 422 });
		expect(m.begin).not.toHaveBeenCalled();
	});
	it('refuses when the Salesforce account is already linked', async () => {
		m.rows = [[{ id: 'existing' }]];
		await expect(provisionFromSalesforce(ctx, input)).rejects.toMatchObject({ status: 409 });
		expect(m.begin).not.toHaveBeenCalled();
	});
	it('refuses a login email that already belongs to a user (point to Account merge)', async () => {
		m.rows = [[], [{ id: 'u1' }]];
		await expect(provisionFromSalesforce(ctx, input)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Account merge') });
		expect(m.begin).not.toHaveBeenCalled();
	});
	it('creates account, owner and stores in one transaction and returns the temp password once', async () => {
		m.rows = [[], []];
		m.begin.mockImplementation(async (fn: (tx: unknown) => Promise<void>) => {
			let n = 0;
			const tx = () => Promise.resolve([{ id: `id${++n}` }]);
			await fn(tx);
		});
		const r = await provisionFromSalesforce(ctx, input);
		expect(m.begin).toHaveBeenCalledTimes(1);
		expect(r).toMatchObject({ accountId: 'id1', userId: 'id2', stores: 1, temporaryPassword: 'Temp-Pass-1', warnings: [] });
		const entry = m.audit.mock.calls[0][0];
		expect(entry.action).toBe('account.provision_from_salesforce');
		expect(JSON.stringify(entry)).not.toContain('Temp-Pass-1');
	});
});
