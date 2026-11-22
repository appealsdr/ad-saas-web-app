import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, sqlMock, sf } = vi.hoisted(() => {
	const sqlQueue: unknown[][] = [];
	return {
		sqlQueue,
		sqlMock: vi.fn(async () => sqlQueue.shift() ?? []),
		sf: {
			listAppMessages: vi.fn(),
			createAppMessage: vi.fn(),
			markAppMessageRead: vi.fn(),
			findCaseStoreLookup: vi.fn()
		}
	};
});
vi.mock('$lib/server/db', () => ({ sql: (...a: unknown[]) => (sqlMock as any)(...a) }));
vi.mock('$lib/server/error_log', () => ({ logError: vi.fn(async () => {}) }));
vi.mock('$lib/server/salesforce', () => sf);

import {
	resolveAccountScope,
	resolveStoreScope,
	resolveCaseScope,
	loadConversation,
	postConversationMessage,
	markConversationRead
} from '../../src/lib/server/messages/conversation';

const USER = { id: 'user-1' };
const SF_ACCOUNT = '001000000000001AAA';
const SF_STORE = 'a01000000000001AAA';
const SF_CASE = '500000000000001AAA';
const CONTACT = '003000000000001AAA';
const form = (o: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(o)) f.set(k, v);
	return f;
};
const queueSql = (...results: unknown[][]) => sqlQueue.push(...results);

beforeEach(() => {
	sqlQueue.length = 0;
	sqlMock.mockClear();
	Object.values(sf).forEach((m) => m.mockReset());
});

describe('tenant scope resolution', () => {
	it('Account: resolves the Salesforce Account from the user’s own account', async () => {
		queueSql([{ account_id: 'acct-1', name: 'Acme', sfdc_account_id: SF_ACCOUNT }]);
		const scope = await resolveAccountScope(USER);
		expect(scope).toMatchObject({ kind: 'account', contextType: 'Account', contextId: SF_ACCOUNT, accountId: 'acct-1' });
		expect(scope?.unavailableReason).toBeNull();
	});
	it('Account: unlinked account is unavailable with a clear reason', async () => {
		queueSql([{ account_id: 'acct-1', name: 'Acme', sfdc_account_id: null }]);
		const scope = await resolveAccountScope(USER);
		expect(scope?.contextId).toBeNull();
		expect(scope?.unavailableReason).toMatch(/not linked to Salesforce/);
	});
	it('Account: no local account → null', async () => {
		queueSql([]);
		expect(await resolveAccountScope(USER)).toBeNull();
	});

	it('Store: uses the tenant-checked store’s sfdc_store_id', async () => {
		queueSql([{ id: 's1', account_id: 'acct-1', name: 'Main', sfdc_store_id: SF_STORE }]);
		const scope = await resolveStoreScope(USER, 's1');
		expect(scope).toMatchObject({ kind: 'store', contextType: 'Store__c', contextId: SF_STORE });
	});
	it('Store: a store outside the user’s account (query returns nothing) → null', async () => {
		queueSql([]);
		expect(await resolveStoreScope(USER, 'someone-elses-store')).toBeNull();
	});
	it('Store: unlinked store is unavailable', async () => {
		queueSql([{ id: 's1', account_id: 'acct-1', name: 'Main', sfdc_store_id: null }]);
		const scope = await resolveStoreScope(USER, 's1');
		expect(scope?.contextId).toBeNull();
		expect(scope?.unavailableReason).toMatch(/store is not linked/);
	});

	describe('Case', () => {
		const store = { id: 's1', account_id: 'acct-1', name: 'Main', sfdc_store_id: SF_STORE };
		it('accepts a case whose Store__c matches the owned store', async () => {
			queueSql([store]);
			sf.findCaseStoreLookup.mockResolvedValue({ ok: true, sfdcCaseId: SF_CASE, sfdcStoreId: SF_STORE });
			expect(await resolveCaseScope(USER, 's1', SF_CASE)).toMatchObject({ contextType: 'Case', contextId: SF_CASE });
		});
		it('rejects a case that belongs to a different store/tenant', async () => {
			queueSql([store]);
			sf.findCaseStoreLookup.mockResolvedValue({ ok: true, sfdcCaseId: SF_CASE, sfdcStoreId: 'a01000000000999AAA' });
			expect(await resolveCaseScope(USER, 's1', SF_CASE)).toBeNull();
		});
		it('rejects an unknown case', async () => {
			queueSql([store]);
			sf.findCaseStoreLookup.mockResolvedValue({ ok: false, error: 'Case not found.', notFound: true });
			expect(await resolveCaseScope(USER, 's1', SF_CASE)).toBeNull();
		});
		it('rejects when the store is not the user’s', async () => {
			queueSql([]);
			expect(await resolveCaseScope(USER, 'other', SF_CASE)).toBeNull();
			expect(sf.findCaseStoreLookup).not.toHaveBeenCalled();
		});
		it('fails closed (no context id) on a transient Salesforce error', async () => {
			queueSql([store]);
			sf.findCaseStoreLookup.mockResolvedValue({ ok: false, error: 'timeout' });
			const scope = await resolveCaseScope(USER, 's1', SF_CASE);
			expect(scope?.contextId).toBeNull();
		});
	});
});

const accountScope = {
	kind: 'account' as const,
	contextType: 'Account' as const,
	contextId: SF_ACCOUNT,
	accountId: 'acct-1',
	unavailableReason: null,
	label: 'Acme'
};
const storeScope = { ...accountScope, kind: 'store' as const, contextType: 'Store__c' as const, contextId: SF_STORE };
const caseScope = { ...accountScope, kind: 'case' as const, contextType: 'Case' as const, contextId: SF_CASE };

describe('loadConversation', () => {
	it('sanitizes bodies before they reach the browser', async () => {
		queueSql([{ sfdc_contact_id: CONTACT }]);
		sf.listAppMessages.mockResolvedValue({
			ok: true,
			messages: [{ Id: 'm1', body: '<p>ok</p><script>alert(1)</script>', createdAt: '2026-11-20T10:00:00Z' }]
		});
		const data = await loadConversation(storeScope, USER);
		expect(sf.listAppMessages).toHaveBeenCalledWith(
			{ contextType: 'Store__c', contextId: SF_STORE },
			expect.objectContaining({ userId: 'user-1' })
		);
		expect(data.messages[0].body).toBe('<p>ok</p>');
		expect(data.canSend).toBe(true);
		expect(data.currentContactId).toBe(CONTACT);
	});
	it('does not call Salesforce for an unlinked context', async () => {
		queueSql([{ sfdc_contact_id: CONTACT }]);
		const data = await loadConversation({ ...accountScope, contextId: null, unavailableReason: 'nope' }, USER);
		expect(data).toMatchObject({ available: false, unavailableReason: 'nope', messages: [] });
		expect(sf.listAppMessages).not.toHaveBeenCalled();
	});
	it('reports a load failure without leaking details and keeps the panel usable', async () => {
		queueSql([{ sfdc_contact_id: CONTACT }]);
		sf.listAppMessages.mockResolvedValue({ ok: false, error: 'Could not load messages. Please try again.' });
		const data = await loadConversation(accountScope, USER);
		expect(data.error).toMatch(/Could not load/);
		expect(data.available).toBe(true);
	});
	it('without a linked Contact the user can read but not send', async () => {
		queueSql([{ sfdc_contact_id: null }]);
		sf.listAppMessages.mockResolvedValue({ ok: true, messages: [] });
		const data = await loadConversation(caseScope, USER);
		expect(data.canSend).toBe(false);
		expect(data.sendDisabledReason).toMatch(/Contact is not linked/);
	});
});

describe('postConversationMessage (send actions)', () => {
	it.each([
		['Account', accountScope, SF_ACCOUNT],
		['Store__c', storeScope, SF_STORE],
		['Case', caseScope, SF_CASE]
	])('%s: sends with the scope’s server-resolved context and the user’s Contact', async (type, scope, id) => {
		queueSql([{ sfdc_contact_id: CONTACT }]);
		sf.createAppMessage.mockResolvedValue({ ok: true, id: 'm9' });
		const res = await postConversationMessage(scope, USER, form({ body: '<p>Hi</p>' }));
		expect(res).toEqual({ ok: true });
		expect(sf.createAppMessage).toHaveBeenCalledWith(
			{ contextType: type, contextId: id, senderContactId: CONTACT, body: '<p>Hi</p>', replyToMessageId: null },
			expect.objectContaining({ userId: 'user-1', accountId: 'acct-1' })
		);
	});
	it('ignores any context fields smuggled into the form', async () => {
		queueSql([{ sfdc_contact_id: CONTACT }]);
		sf.createAppMessage.mockResolvedValue({ ok: true, id: 'm9' });
		await postConversationMessage(
			accountScope,
			USER,
			form({ body: 'x', contextId: '001999999999999AAA', contextType: 'Store__c', Account__c: '001999999999999AAA' })
		);
		expect(sf.createAppMessage.mock.calls[0][0]).toMatchObject({ contextType: 'Account', contextId: SF_ACCOUNT });
	});
	it('rejects empty and over-long bodies before touching Salesforce', async () => {
		const empty = await postConversationMessage(accountScope, USER, form({ body: '<p> </p>' }));
		expect(empty).toMatchObject({ ok: false, status: 400 });
		const long = await postConversationMessage(accountScope, USER, form({ body: 'a'.repeat(40000) }));
		expect(long).toMatchObject({ ok: false, status: 400, error: expect.stringMatching(/too long/) });
		expect(sf.createAppMessage).not.toHaveBeenCalled();
	});
	it('requires a linked Salesforce Contact (actionable 409)', async () => {
		queueSql([{ sfdc_contact_id: null }]);
		const res = await postConversationMessage(storeScope, USER, form({ body: 'hi' }));
		expect(res).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/Contact is not linked/) });
		expect(sf.createAppMessage).not.toHaveBeenCalled();
	});
	it('refuses to send into an unlinked context', async () => {
		const res = await postConversationMessage({ ...storeScope, contextId: null, unavailableReason: 'Store not linked' }, USER, form({ body: 'hi' }));
		expect(res).toMatchObject({ ok: false, status: 409, error: 'Store not linked' });
	});
	it('maps a cross-context reply rejection to 400 and other failures to 502', async () => {
		queueSql([{ sfdc_contact_id: CONTACT }], [{ sfdc_contact_id: CONTACT }]);
		sf.createAppMessage
			.mockResolvedValueOnce({ ok: false, error: 'You can only reply to a message in the same conversation.' })
			.mockResolvedValueOnce({ ok: false, error: 'Salesforce could not save the message. Please try again.' });
		const reply = await postConversationMessage(accountScope, USER, form({ body: 'hi', replyToMessageId: 'a02000000000001AAA' }));
		expect(reply).toMatchObject({ ok: false, status: 400 });
		const other = await postConversationMessage(accountScope, USER, form({ body: 'hi' }));
		expect(other).toMatchObject({ ok: false, status: 502 });
	});
});

describe('markConversationRead', () => {
	it('passes the scope so foreign message ids are refused by the helper', async () => {
		sf.markAppMessageRead.mockResolvedValue({ ok: true });
		const res = await markConversationRead(storeScope, USER, 'a02000000000001AAA');
		expect(res).toEqual({ ok: true });
		expect(sf.markAppMessageRead).toHaveBeenCalledWith(
			'a02000000000001AAA',
			expect.objectContaining({ userId: 'user-1' }),
			{ contextType: 'Store__c', contextId: SF_STORE }
		);
	});
	it('rejects a missing id and an unavailable context', async () => {
		expect(await markConversationRead(storeScope, USER, '')).toMatchObject({ ok: false, status: 400 });
		expect(await markConversationRead({ ...storeScope, contextId: null }, USER, 'x')).toMatchObject({ ok: false, status: 409 });
	});
	it('surfaces a failed update', async () => {
		sf.markAppMessageRead.mockResolvedValue({ ok: false, error: 'Message not found in this conversation.' });
		expect(await markConversationRead(caseScope, USER, 'a02000000000001AAA')).toMatchObject({ ok: false, status: 502 });
	});
});
