import { describe, it, expect, vi, beforeEach } from 'vitest';

const sfdcQuery = vi.fn();
const sobjectCreate = vi.fn();
const sobjectUpdate = vi.fn();
vi.mock('../../src/lib/server/salesforce/client', () => ({
	sfdcQuery: (...a: unknown[]) => sfdcQuery(...a),
	sobjectCreate: (...a: unknown[]) => sobjectCreate(...a),
	sobjectUpdate: (...a: unknown[]) => sobjectUpdate(...a),
	sobjectGet: vi.fn(),
	SalesforceApiError: class extends Error {}
}));
vi.mock('../../src/lib/server/error_log', () => ({ logError: vi.fn(async () => {}) }));

import {
	listCaseMessages,
	createCaseMessage,
	markCaseMessageRead,
	listRecentMessagesForCases
} from '../../src/lib/server/salesforce/cases';

const CASE = '500000000000001AAA';
const CONTACT = '003000000000001AAA';
const row = {
	Id: 'a02000000000001AAA',
	Message_Body__c: '<p>x</p>',
	Sender_Type__c: 'internal',
	Sender_Contact__c: null,
	Sender_Contact__r: null,
	CreatedById: 'u',
	CreatedBy: { Name: 'Dana' },
	CreatedDate: '2026-11-20T10:00:00Z',
	Reply_To_Message__c: null,
	Message_Read__c: null
};

beforeEach(() => {
	sfdcQuery.mockReset();
	sobjectCreate.mockReset();
	sobjectUpdate.mockReset();
});

describe('Case messaging regression (compat wrappers)', () => {
	it('listCaseMessages only reads messages assigned to the Case', async () => {
		sfdcQuery.mockResolvedValue({ records: [row] });
		const res = await listCaseMessages(CASE);
		expect(res.ok && res.messages[0].displayName).toBe('Dana');
		const soql = sfdcQuery.mock.calls[0][0] as string;
		expect(soql).toContain(`Case__c = '${CASE}'`);
		expect(soql).not.toContain('Account__c');
	});
	it('createCaseMessage sets Case__c only', async () => {
		sobjectCreate.mockResolvedValue({ success: true, id: 'a02000000000009AAA' });
		const res = await createCaseMessage({ caseId: CASE, senderContactId: CONTACT, body: '<p>hi</p>' });
		expect(res).toEqual({ ok: true, id: 'a02000000000009AAA' });
		const payload = sobjectCreate.mock.calls[0][1];
		expect(payload.Case__c).toBe(CASE);
		expect(payload).not.toHaveProperty('Account__c');
		expect(payload).not.toHaveProperty('Store__c');
	});
	it('markCaseMessageRead stamps Message_Read__c', async () => {
		sobjectUpdate.mockResolvedValue(undefined);
		expect((await markCaseMessageRead('a02000000000001AAA')).ok).toBe(true);
		expect(sobjectUpdate.mock.calls[0][2]).toHaveProperty('Message_Read__c');
	});
	it('listRecentMessagesForCases keeps the dashboard shape (caseId/caseNumber) and includes read messages', async () => {
		sfdcQuery.mockResolvedValue({
			records: [{ ...row, Case__c: CASE, Case__r: { CaseNumber: '00001042' }, Message_Read__c: '2026-11-20T11:00:00Z' }]
		});
		const res = await listRecentMessagesForCases([CASE], 5);
		expect(sfdcQuery.mock.calls[0][0]).not.toContain('Message_Read__c = null');
		expect(res.ok && res.messages[0]).toMatchObject({ caseId: CASE, caseNumber: '00001042' });
		expect(await listRecentMessagesForCases([], 5)).toEqual({ ok: true, messages: [] });
	});
});
