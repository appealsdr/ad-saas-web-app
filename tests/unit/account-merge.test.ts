import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	stmts: [] as string[],
	sides: {} as Record<string, unknown>,
	sfUpdate: vi.fn(),
	sfAccount: vi.fn(),
	audit: vi.fn(),
	beginCalls: 0
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: (e: unknown) => ({ errorMessage: String(e), stack: '' }) }));
vi.mock('$lib/server/admin/audit', () => ({ recordAudit: m.audit }));
vi.mock('$lib/server/salesforce/client', () => ({ sobjectUpdate: m.sfUpdate, sfdcQuery: async () => ({ records: [] }) }));
vi.mock('$lib/server/salesforce/records', () => ({ updateSalesforceAccount: m.sfAccount }));
vi.mock('$lib/server/db', () => {
	const handler = (strings: unknown, ...values: unknown[]) => {
		if (!Array.isArray(strings)) return { fragment: true };
		const text = (strings as string[]).join('?').replace(/\s+/g, ' ').trim();
		m.stmts.push(text);
		const side = (id: unknown) => m.sides[String(id)] as { account: unknown; users: unknown[]; stores: unknown[]; contracts: unknown[] } | undefined;
		if (/FROM accounts WHERE id = \?$/.test(text)) return Promise.resolve(side(values[0]) ? [side(values[0])!.account] : []);
		if (/FROM users WHERE account_id/.test(text)) return Promise.resolve(side(values[0])?.users ?? []);
		if (/FROM stores WHERE account_id/.test(text)) return Promise.resolve(side(values[0])?.stores ?? []);
		if (/FROM service_contracts WHERE account_id/.test(text)) return Promise.resolve(side(values[0])?.contracts ?? []);
		if (/SELECT \(SELECT count/.test(text)) return Promise.resolve([{ contacts: 1, activity: 2 }]);
		if (/UPDATE stores SET account_id .* RETURNING/.test(text) || /UPDATE service_contracts SET account_id .* RETURNING/.test(text)) {
			return Promise.resolve((values[1] as string[]).map((id) => ({ id })));
		}
		if (/UPDATE account_contacts/.test(text)) return Promise.resolve([{ id: 'ct1', sfdc_contact_id: 'SFCONTACT0000001' }]);
		if (/UPDATE activity_log/.test(text)) return Promise.resolve([{ id: 'a1' }, { id: 'a2' }]);
		if (/INSERT INTO account_merges/.test(text)) return Promise.resolve([{ id: 'merge1' }]);
		return Promise.resolve([]);
	};
	const withJson = Object.assign(handler, { json: (v: unknown) => v });
	const sql = Object.assign(handler, {
		json: (v: unknown) => v,
		begin: async (fn: (tx: unknown) => Promise<unknown>) => { m.beginCalls++; return fn(withJson); }
	});
	return { sql };
});

import { validateMerge, defaultChoices, mergeAccounts, type MergeSide, type MergeChoices } from '../../src/lib/server/admin/merge';
import { ActionError } from '../../src/lib/server/admin/actions';

const A = '11111111-1111-4111-8111-111111111111'; // survivor
const B = '22222222-2222-4222-8222-222222222222'; // duplicate
const ctx = { actor: { userId: null, ref: 'staff@x.com', role: 'platform_admin' } };

const account = (id: string, over: Record<string, unknown> = {}) => ({
	id, name: id === A ? 'Acme' : 'Acme Duplicate', email: null, phone: null, website: null, billing_street: null, billing_city: null, billing_state: null,
	billing_postal_code: null, billing_country: null, sfdc_account_id: null, stripe_customer_id: null, active_subscription_contract_id: null,
	merged_into_account_id: null, created_at: '2026-01-01', ...over
});
const user = (id: string, role = 'owner', over: Record<string, unknown> = {}) => ({ id, email: `${id}@x.com`, display_name: id, role, is_active: true, sfdc_contact_id: null, ...over });
const side = (id: string, over: Partial<MergeSide> = {}): MergeSide => ({ account: account(id) as never, users: [], stores: [], contracts: [], contactCount: 1, activityCount: 2, ...over });

function pair(): { s: MergeSide; t: MergeSide } {
	return {
		s: side(A, { users: [user('uA', 'owner')], stores: [{ id: 'sA', name: 'Main', seller_id: 'SELLER1', sfdc_store_id: null }] }),
		t: side(B, {
			users: [user('uB', 'owner')],
			stores: [{ id: 'sB', name: 'Other', seller_id: 'SELLER2', sfdc_store_id: 'a0Xstore00000001' }],
			contracts: [{ id: 'cB', kind: 'service', status: 'active', store_id: 'sB', sfdc_service_contract_id: '800contract00001', amount_cents: 1000, currency: 'usd', paid_at: '2026-02-01' }]
		})
	};
}
const choices = (s: MergeSide, t: MergeSide, over: Partial<MergeChoices> = {}): MergeChoices => ({ ...defaultChoices(s, t), reason: 'Same client registered twice', confirm: 'Acme', ...over });

describe('defaultChoices', () => {
	it('keeps one owner (demotes the duplicate\'s owner) and moves everything', () => {
		const { s, t } = pair();
		const c = defaultChoices(s, t);
		expect(c.users).toEqual({ uA: 'owner', uB: 'admin' });
		expect(c.storeIds).toEqual(['sB']);
		expect(c.contractIds).toEqual(['cB']);
	});
	it('takes a value from the duplicate only where the survivor has none', () => {
		const { s, t } = pair();
		(s.account as { phone: string | null }).phone = '111';
		(t.account as { phone: string | null }).phone = '222';
		(t.account as { website: string | null }).website = 'acme.com';
		const c = defaultChoices(s, t);
		expect(c.fields.phone).toBe('survivor');
		expect(c.fields.website).toBe('source');
	});
});

describe('validateMerge', () => {
	it('accepts the defaults with a reason and confirmation', () => {
		const { s, t } = pair();
		expect(validateMerge(s, t, choices(s, t)).errors).toEqual([]);
	});
	it('requires exactly one owner and at least one active login', () => {
		const { s, t } = pair();
		expect(validateMerge(s, t, choices(s, t, { users: { uA: 'owner', uB: 'owner' } })).errors.join()).toContain('exactly one owner');
		expect(validateMerge(s, t, choices(s, t, { users: { uA: 'member', uB: 'member' } })).errors.join()).toContain('exactly one owner');
		expect(validateMerge(s, t, choices(s, t, { users: { uA: 'disable', uB: 'disable' } })).errors.join()).toContain('At least one login');
		expect(validateMerge(s, t, choices(s, t, { users: { uA: 'owner' } })).errors.join()).toContain('uB@x.com');
	});
	it('blocks moving a store that has the same seller ID as one in the final account', () => {
		const { s, t } = pair();
		t.stores[0].seller_id = 'seller1';
		expect(validateMerge(s, t, choices(s, t)).errors.join()).toContain('same seller ID');
		expect(validateMerge(s, t, choices(s, t, { storeIds: [], contractIds: [] })).errors).toEqual([]);
	});
	it('blocks a contract whose store is not moved, and a second active subscription', () => {
		const { s, t } = pair();
		expect(validateMerge(s, t, choices(s, t, { storeIds: [] })).errors.join()).toContain('Move that store too');
		(s.account as { active_subscription_contract_id: string | null }).active_subscription_contract_id = 'subA';
		(t.account as { active_subscription_contract_id: string | null }).active_subscription_contract_id = 'cB';
		expect(validateMerge(s, t, choices(s, t)).errors.join()).toContain('active subscription');
	});
	it('rejects foreign ids, bad confirmation, already-merged accounts and a Stripe pick with no customer', () => {
		const { s, t } = pair();
		expect(validateMerge(s, t, choices(s, t, { storeIds: ['nope'] })).errors.join()).toContain('does not belong');
		expect(validateMerge(s, t, choices(s, t, { confirm: 'wrong' })).errors.join()).toContain('Type the final account');
		expect(validateMerge(s, t, choices(s, t, { stripe: 'source' })).errors.join()).toContain('no Stripe customer');
		(t.account as { merged_into_account_id: string | null }).merged_into_account_id = A;
		expect(validateMerge(s, t, choices(s, t)).errors.join()).toContain('already been merged');
	});
	it('warns (does not block) when Salesforce is not updated for moved contracts', () => {
		const { s, t } = pair();
		const v = validateMerge(s, t, choices(s, t, { salesforce: false }));
		expect(v.errors).toEqual([]);
		expect(v.warnings.join()).toContain('Salesforce is not being updated');
	});
});

describe('mergeAccounts', () => {
	beforeEach(() => {
		m.stmts = []; m.beginCalls = 0;
		m.audit.mockReset(); m.sfUpdate.mockReset().mockResolvedValue(undefined); m.sfAccount.mockReset().mockResolvedValue({ ok: true });
		const { s, t } = pair();
		m.sides = { [A]: s, [B]: t };
	});

	it('refuses without a reason or with invalid choices, before any transaction', async () => {
		const { s, t } = pair();
		await expect(mergeAccounts(ctx, A, B, choices(s, t, { reason: 'x' }))).rejects.toBeInstanceOf(ActionError);
		await expect(mergeAccounts(ctx, A, B, choices(s, t, { confirm: 'nope' }))).rejects.toMatchObject({ status: 422 });
		await expect(mergeAccounts(ctx, A, A, choices(s, t))).rejects.toMatchObject({ status: 422 });
		expect(m.beginCalls).toBe(0);
	});

	it('moves the chosen data in one transaction, retires the duplicate and never deletes accounts, stores or contracts', async () => {
		const { s, t } = pair();
		const r = await mergeAccounts(ctx, A, B, choices(s, t, { salesforce: false }));
		expect(m.beginCalls).toBe(1);
		expect(r).toMatchObject({ mergeId: 'merge1', moved: { users: 1, disabled: 0, stores: 1, contracts: 1, contacts: 1, activity: 2 }, salesforce: { attempted: false } });
		const all = m.stmts.join('\n');
		expect(all).toContain('FOR UPDATE');
		expect(all).toMatch(/UPDATE users SET account_id = \?, role = \? WHERE id = \?/);
		expect(all).toMatch(/UPDATE accounts SET merged_into_account_id/);
		expect(all).toMatch(/INSERT INTO account_merges/);
		expect(all).not.toMatch(/DELETE FROM (accounts|stores|service_contracts|users)/);
		expect(m.audit).toHaveBeenCalledTimes(1);
		expect(m.audit.mock.calls[0][0]).toMatchObject({ action: 'account.merge', targetId: A, outcome: 'success' });
	});

	it('disables a login and revokes its sessions instead of deleting it', async () => {
		const { s, t } = pair();
		const r = await mergeAccounts(ctx, A, B, choices(s, t, { salesforce: false, users: { uA: 'owner', uB: 'disable' } }));
		expect(r.moved).toMatchObject({ users: 0, disabled: 1 });
		const all = m.stmts.join('\n');
		expect(all).toMatch(/UPDATE users SET is_active = false/);
		expect(all).toMatch(/DELETE FROM sessions WHERE user_id/);
	});

	it('re-parents moved records in Salesforce and reports failures per record', async () => {
		const SF_S = '001SURVIVOR00001';
		const SF_T = '001DUPLICATE00001';
		const { s, t } = pair();
		(s.account as { sfdc_account_id: string }).sfdc_account_id = SF_S;
		(t.account as { sfdc_account_id: string }).sfdc_account_id = SF_T;
		m.sides = { [A]: s, [B]: t };
		m.sfUpdate.mockImplementation(async (obj: string) => { if (obj === 'ServiceContract') throw new Error('locked'); });
		const r = await mergeAccounts(ctx, A, B, choices(s, t));
		expect(m.sfUpdate).toHaveBeenCalledWith('Store__c', 'a0Xstore00000001', { Account__c: SF_S });
		expect(m.sfUpdate).toHaveBeenCalledWith('ServiceContract', '800contract00001', { AccountId: SF_S });
		expect(m.sfUpdate).toHaveBeenCalledWith('Contact', 'SFCONTACT0000001', { AccountId: SF_S });
		expect(r.salesforce).toMatchObject({ attempted: true, ok: 2 });
		expect(r.salesforce.failed).toEqual([{ object: 'ServiceContract', id: '800contract00001', error: 'Error: locked' }]);
	});
});
