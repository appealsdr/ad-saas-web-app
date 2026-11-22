import { describe, it, expect, vi, beforeEach } from 'vitest';

const sfdcQuery = vi.fn();
const sobjectCreate = vi.fn();
const sobjectUpdate = vi.fn();
vi.mock('../../src/lib/server/salesforce/client', () => ({
	sfdcQuery: (...a: unknown[]) => sfdcQuery(...a),
	sobjectCreate: (...a: unknown[]) => sobjectCreate(...a),
	sobjectUpdate: (...a: unknown[]) => sobjectUpdate(...a),
	SalesforceApiError: class SalesforceApiError extends Error {
		status = 400;
		errorCode = 'X';
	}
}));
vi.mock('../../src/lib/server/error_log', () => ({ logError: vi.fn(async () => {}) }));

import {
	contextLookupField,
	validateAppMessageContext,
	isValidSalesforceId,
	listAppMessages,
	createAppMessage,
	markAppMessageRead,
	listRecentAppMessagesForContexts
} from '../../src/lib/server/salesforce/app-messages';

const CASE_ID = '500000000000001AAA';
const ACCOUNT_ID = '001000000000001AAA';
const STORE_ID = 'a01000000000001AAA';
const CONTACT_ID = '003000000000001AAA';
const MSG_ID = 'a02000000000001AAA';

const row = (over: Record<string, unknown> = {}) => ({
	Id: MSG_ID,
	Message_Body__c: '<p>hi</p>',
	Sender_Type__c: 'external',
	Sender_Contact__c: CONTACT_ID,
	Sender_Contact__r: { Name: 'Pat Seller' },
	CreatedById: '005000000000001AAA',
	CreatedBy: { Name: 'Integration User' },
	CreatedDate: '2026-11-20T10:00:00.000Z',
	Reply_To_Message__c: null,
	Message_Read__c: null,
	...over
});

beforeEach(() => {
	sfdcQuery.mockReset();
	sobjectCreate.mockReset();
	sobjectUpdate.mockReset();
});

describe('context → lookup field', () => {
	it('maps each supported context to its Case_Message__c lookup', () => {
		expect(contextLookupField('Case')).toBe('Case__c');
		expect(contextLookupField('Account')).toBe('Account__c');
		expect(contextLookupField('Store__c')).toBe('Store__c');
	});
	it('throws on unsupported types', () => {
		expect(() => contextLookupField('Contact' as never)).toThrow(/Unsupported/);
	});
});

describe('validateAppMessageContext / ids', () => {
	it('accepts the three contexts with well-formed 15/18-char ids', () => {
		for (const [contextType, contextId] of [
			['Case', CASE_ID],
			['Account', ACCOUNT_ID],
			['Store__c', STORE_ID.slice(0, 15)]
		] as const) {
			expect(validateAppMessageContext({ contextType, contextId }).ok).toBe(true);
		}
	});
	it('rejects missing, unsupported and malformed input with clear errors', () => {
		const bad = (c: unknown) => {
			const r = validateAppMessageContext(c as never);
			return r.ok ? null : r.error;
		};
		expect(bad(null)).toMatch(/Missing message context/);
		expect(bad({ contextId: CASE_ID })).toMatch(/Missing message context type/);
		expect(bad({ contextType: 'Opportunity', contextId: CASE_ID })).toMatch(/Unsupported/);
		expect(bad({ contextType: 'Case' })).toMatch(/Missing message context record/);
		expect(bad({ contextType: 'Case', contextId: "x' OR Id != '" })).toMatch(/Invalid/);
		expect(bad({ contextType: 'Case', contextId: 'short' })).toMatch(/Invalid/);
	});
	it('isValidSalesforceId', () => {
		expect(isValidSalesforceId(CASE_ID)).toBe(true);
		expect(isValidSalesforceId("500'; DROP")).toBe(false);
		expect(isValidSalesforceId(undefined)).toBe(false);
	});
});

describe('listAppMessages', () => {
	it.each([
		['Case', CASE_ID, 'Case__c'],
		['Account', ACCOUNT_ID, 'Account__c'],
		['Store__c', STORE_ID, 'Store__c']
	] as const)('%s: queries the right lookup and maps rows', async (contextType, contextId, field) => {
		sfdcQuery.mockResolvedValue({ records: [row()] });
		const res = await listAppMessages({ contextType, contextId });
		expect(res.ok).toBe(true);
		const soql = sfdcQuery.mock.calls[0][0] as string;
		expect(soql).toContain(`WHERE ${field} = '${contextId}'`);
		expect(soql).toContain('ORDER BY CreatedDate ASC');
		if (res.ok) {
			expect(res.messages).toEqual([
				expect.objectContaining({
					Id: MSG_ID,
					body: '<p>hi</p>',
					displayName: 'Pat Seller',
					senderContactId: CONTACT_ID,
					replyToMessageId: null,
					messageRead: null
				})
			]);
		}
	});
	it('falls back to the creating user for the display name', async () => {
		sfdcQuery.mockResolvedValue({ records: [row({ Sender_Contact__r: null })] });
		const res = await listAppMessages({ contextType: 'Case', contextId: CASE_ID });
		expect(res.ok && res.messages[0].displayName).toBe('Integration User');
	});
	it('never queries Salesforce for invalid contexts', async () => {
		const res = await listAppMessages({ contextType: 'Account', contextId: "bad'id" });
		expect(res.ok).toBe(false);
		expect(sfdcQuery).not.toHaveBeenCalled();
	});
	it('hides Salesforce error details from the caller', async () => {
		sfdcQuery.mockRejectedValue(new Error('INVALID_FIELD: No such column Account__c on Case_Message__c'));
		const res = await listAppMessages({ contextType: 'Account', contextId: ACCOUNT_ID });
		expect(res).toEqual({ ok: false, error: expect.not.stringContaining('INVALID_FIELD') });
	});
});

describe('createAppMessage', () => {
	const base = { senderContactId: CONTACT_ID, body: '<p>Hello</p>' };

	it.each([
		['Case', CASE_ID, 'Case__c'],
		['Account', ACCOUNT_ID, 'Account__c'],
		['Store__c', STORE_ID, 'Store__c']
	] as const)('%s: populates exactly one context lookup', async (contextType, contextId, field) => {
		sobjectCreate.mockResolvedValue({ success: true, id: MSG_ID });
		const res = await createAppMessage({ ...base, contextType, contextId });
		expect(res).toEqual({ ok: true, id: MSG_ID });
		const [object, payload] = sobjectCreate.mock.calls[0];
		expect(object).toBe('Case_Message__c');
		const lookups = ['Case__c', 'Account__c', 'Store__c'].filter((f) => f in payload);
		expect(lookups).toEqual([field]);
		expect(payload[field]).toBe(contextId);
		expect(payload).toMatchObject({
			Sender_Contact__c: CONTACT_ID,
			Message_Body__c: '<p>Hello</p>',
			Sender_Type__c: 'external'
		});
	});

	it('rejects unsupported, missing and malformed context / sender / body', async () => {
		const cases: [Partial<Parameters<typeof createAppMessage>[0]>, RegExp][] = [
			[{ contextType: 'Contact' as never, contextId: CASE_ID }, /Unsupported/],
			[{ contextType: 'Case', contextId: '' }, /Missing message context record/],
			[{ contextType: 'Case', contextId: 'nope' }, /Invalid message context/],
			[{ contextType: 'Case', contextId: CASE_ID, senderContactId: '' }, /Missing sender/],
			[{ contextType: 'Case', contextId: CASE_ID, senderContactId: 'bad id' }, /Invalid sender/],
			[{ contextType: 'Case', contextId: CASE_ID, body: '   ' }, /cannot be empty/]
		];
		for (const [over, err] of cases) {
			const res = await createAppMessage({ ...base, ...over } as never);
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.error).toMatch(err);
		}
		expect(sobjectCreate).not.toHaveBeenCalled();
	});

	it('rejects replies to a message from another context', async () => {
		sfdcQuery.mockResolvedValue({ records: [] }); // reply row not in THIS context
		const res = await createAppMessage({
			...base,
			contextType: 'Store__c',
			contextId: STORE_ID,
			replyToMessageId: MSG_ID
		});
		expect(res).toEqual({ ok: false, error: expect.stringMatching(/same conversation/) });
		expect(sfdcQuery.mock.calls[0][0]).toContain(`Store__c = '${STORE_ID}'`);
		expect(sobjectCreate).not.toHaveBeenCalled();
	});

	it('allows replies within the same context and links Reply_To_Message__c', async () => {
		sfdcQuery.mockResolvedValue({ records: [{ Id: MSG_ID }] });
		sobjectCreate.mockResolvedValue({ success: true, id: 'a02000000000002AAA' });
		const res = await createAppMessage({
			...base,
			contextType: 'Account',
			contextId: ACCOUNT_ID,
			replyToMessageId: MSG_ID
		});
		expect(res.ok).toBe(true);
		expect(sobjectCreate.mock.calls[0][1]).toMatchObject({ Reply_To_Message__c: MSG_ID, Account__c: ACCOUNT_ID });
	});

	it('rejects a malformed reply id without touching Salesforce', async () => {
		const res = await createAppMessage({ ...base, contextType: 'Case', contextId: CASE_ID, replyToMessageId: "x'--" });
		expect(res.ok).toBe(false);
		expect(sfdcQuery).not.toHaveBeenCalled();
	});

	it('returns a generic error when Salesforce rejects the create', async () => {
		sobjectCreate.mockRejectedValue(new Error('FIELD_INTEGRITY_EXCEPTION secret detail'));
		const res = await createAppMessage({ ...base, contextType: 'Case', contextId: CASE_ID });
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).not.toContain('secret detail');
	});
});

describe('markAppMessageRead (read receipts)', () => {
	it('stamps Message_Read__c', async () => {
		sobjectUpdate.mockResolvedValue(undefined);
		const res = await markAppMessageRead(MSG_ID);
		expect(res.ok).toBe(true);
		const [object, id, fields] = sobjectUpdate.mock.calls[0];
		expect([object, id]).toEqual(['Case_Message__c', MSG_ID]);
		expect(new Date(fields.Message_Read__c).getTime()).not.toBeNaN();
	});
	it('with a scope, refuses messages that belong to another context', async () => {
		sfdcQuery.mockResolvedValue({ records: [] });
		const res = await markAppMessageRead(MSG_ID, {}, { contextType: 'Account', contextId: ACCOUNT_ID });
		expect(res.ok).toBe(false);
		expect(sobjectUpdate).not.toHaveBeenCalled();
	});
	it('with a scope, marks messages that belong to it', async () => {
		sfdcQuery.mockResolvedValue({ records: [{ Id: MSG_ID }] });
		sobjectUpdate.mockResolvedValue(undefined);
		const res = await markAppMessageRead(MSG_ID, {}, { contextType: 'Store__c', contextId: STORE_ID });
		expect(res.ok).toBe(true);
	});
	it('rejects missing and malformed ids', async () => {
		expect((await markAppMessageRead('')).ok).toBe(false);
		expect((await markAppMessageRead("1' OR '1'='1")).ok).toBe(false);
		expect(sobjectUpdate).not.toHaveBeenCalled();
	});
});

describe('listRecentAppMessagesForContexts', () => {
	it('returns nothing without a round-trip for empty input', async () => {
		const res = await listRecentAppMessagesForContexts('Case', [], 10);
		expect(res).toEqual({ ok: true, messages: [] });
		expect(sfdcQuery).not.toHaveBeenCalled();
	});
	it('filters unread in SOQL, scopes by the right lookup and tags each message with its context', async () => {
		sfdcQuery.mockResolvedValue({ records: [{ ...row(), Store__c: STORE_ID }] });
		const res = await listRecentAppMessagesForContexts('Store__c', [STORE_ID], 50, {}, { unreadOnly: true });
		const soql = sfdcQuery.mock.calls[0][0] as string;
		expect(soql).toContain(`Store__c IN ('${STORE_ID}')`);
		expect(soql).toContain('Message_Read__c = null');
		expect(res.ok && res.messages[0]).toMatchObject({ contextType: 'Store__c', contextId: STORE_ID, caseNumber: null });
	});
	it('can include read messages (dashboard feed) and exposes the case number', async () => {
		sfdcQuery.mockResolvedValue({ records: [{ ...row(), Case__c: CASE_ID, Case__r: { CaseNumber: '00001042' } }] });
		const res = await listRecentAppMessagesForContexts('Case', [CASE_ID], 10);
		expect(sfdcQuery.mock.calls[0][0]).not.toContain('Message_Read__c = null');
		expect(res.ok && res.messages[0]).toMatchObject({ contextId: CASE_ID, caseNumber: '00001042' });
	});
	it('rejects malformed ids', async () => {
		const res = await listRecentAppMessagesForContexts('Case', ["a' OR 1=1"], 10);
		expect(res.ok).toBe(false);
		expect(sfdcQuery).not.toHaveBeenCalled();
	});
});
