/** "Waiting on Client" → "In Progress - Tech": when it is offered, when it is automatic, and the client's own request. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
	status: 'Waiting on Client',
	onboardingConfig: null as string | null,
	onboardingProvided: false,
	files: [] as Row[],
	messages: [] as Row[], // newest first
	noOnboardingFields: false,
	fail: null as RegExp | null,
	updates: [] as { object: string; id: string; body: Row }[],
	logged: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db', () => ({ sql: vi.fn(async () => []) }));
vi.mock('$lib/server/error_log', () => ({ logError: async (e: unknown) => m.logged(e), describeError: () => ({ errorMessage: 'x', stack: '' }) }));
vi.mock('$lib/server/salesforce/config', () => ({ getSalesforceConfig: () => ({ apiVersion: 'v60.0' }) }));
vi.mock('$lib/server/salesforce/s3-documents', () => ({ createS3Document: async () => ({ ok: true, id: 'a0D000000000001' }) }));
vi.mock('$lib/server/salesforce/client', async (original) => {
	const actual = await original<typeof import('../../src/lib/server/salesforce/client')>();
	return {
		...actual,
		sfdcFetch: vi.fn(async () => ({ fields: [{ name: 'ASIN__c', label: 'ASIN', type: 'string', updateable: true }] })),
		sfdcQuery: vi.fn(async (soql: string) => {
			if (m.fail?.test(soql)) throw new actual.SalesforceApiError('boom', 500);
			let records: Row[] = [];
			if (/FROM Required_File__c/.test(soql)) records = m.files;
			else if (/FROM Case_Message__c/.test(soql)) records = m.messages.slice(0, 1);
			else if (/FROM Case\b/.test(soql)) {
				if (m.noOnboardingFields && soql.includes('Case_Onboarding__c')) throw new actual.SalesforceApiError('No such column', 400, 'INVALID_FIELD');
				records = [{ Id: '500000000000001', Status: m.status, Case_Onboarding__c: m.onboardingConfig, Onboarding_Info_Provided__c: m.onboardingProvided, ASIN__c: null }];
			}
			return { records, done: true, totalSize: records.length };
		}),
		sobjectCreate: vi.fn(async () => {
			m.messages.unshift({ Sender_Type__c: 'external' });
			return { success: true, id: 'a0M000000000001', errors: [] };
		}),
		sobjectUpdate: vi.fn(async (object: string, id: string, body: Row) => {
			m.updates.push({ object, id, body });
			if (object === 'Required_File__c') m.files = m.files.map((f) => (f.Id === id ? { ...f, ...body } : f));
			if (object === 'Case' && 'Onboarding_Info_Provided__c' in body) m.onboardingProvided = true;
		})
	};
});

import { advanceCaseWhenClientDone, isCaseReadyForTechnician, notifyTechnician } from '../../src/lib/server/salesforce/case-auto-status';
import { createAppMessage } from '../../src/lib/server/salesforce/app-messages';
import { attachUploadToRequiredFile } from '../../src/lib/server/salesforce/required-files';
import { saveCaseOnboarding } from '../../src/lib/server/salesforce/case-onboarding';

const CASE = '500000000000001';
const CONFIG = '[{"fieldapiname":"ASIN__c","required":false}]';
const team = { Sender_Type__c: 'Internal' };
const client = { Sender_Type__c: 'external' };
const done = { Id: 'a0R000000000001', File_Uploaded__c: true, Last_Version__c: 'a0D000000000001' };
const missing = { Id: 'a0R000000000002', File_Uploaded__c: false, Last_Version__c: null };
const moved = () => m.updates.filter((u) => u.object === 'Case' && 'Status' in u.body);

beforeEach(() => {
	Object.assign(m, { status: 'Waiting on Client', onboardingConfig: null, onboardingProvided: false, files: [], messages: [], noOnboardingFields: false, fail: null });
	m.updates.length = 0;
	m.logged.mockClear();
});

describe('advanceCaseWhenClientDone', () => {
	it('moves the case when the client replied, every file is uploaded and onboarding is provided', async () => {
		Object.assign(m, { messages: [client, team], files: [done], onboardingConfig: CONFIG, onboardingProvided: true });
		expect(await advanceCaseWhenClientDone(CASE)).toBe(true);
		expect(moved()).toEqual([{ object: 'Case', id: CASE, body: { Status: 'In Progress - Tech' } }]);
	});

	it.each([
		['our message is unanswered', { messages: [team, client], files: [done] }],
		['a file is missing', { messages: [client, team], files: [done, missing] }],
		['onboarding is not provided', { messages: [client], onboardingConfig: CONFIG }],
		['nothing was asked', {}]
	])('stays waiting when %s', async (_why, state) => {
		Object.assign(m, state);
		expect(await advanceCaseWhenClientDone(CASE)).toBe(false);
		expect(moved()).toEqual([]);
	});

	it('only needs what was asked: files alone, or a reply alone', async () => {
		m.files = [done];
		expect(await advanceCaseWhenClientDone(CASE)).toBe(true);
		Object.assign(m, { files: [], messages: [client, team] });
		expect(await advanceCaseWhenClientDone(CASE)).toBe(true);
	});

	it('leaves every other status alone', async () => {
		for (const status of ['New', 'In Progress', 'In Progress - Tech', 'Closed', 'Waiting on Amazon']) {
			Object.assign(m, { status, messages: [client], files: [done] });
			expect(await advanceCaseWhenClientDone(CASE), status).toBe(false);
		}
		expect(moved()).toEqual([]);
	});

	it('changes nothing, and does not throw, when something cannot be read', async () => {
		for (const fail of [/FROM Case\b/, /FROM Required_File__c/, /FROM Case_Message__c/]) {
			Object.assign(m, { fail, messages: [client], files: [done] });
			expect(await advanceCaseWhenClientDone(CASE), String(fail)).toBe(false);
		}
		expect(moved()).toEqual([]);
		expect(m.logged).toHaveBeenCalledTimes(3);
	});

	it('works in an org without the onboarding fields, and ignores a bad id', async () => {
		Object.assign(m, { noOnboardingFields: true, messages: [client] });
		expect(await advanceCaseWhenClientDone(CASE)).toBe(true);
		expect(await advanceCaseWhenClientDone("500' OR Id != '")).toBe(false);
	});
});

describe('web app: the client decides', () => {
	const message = () => createAppMessage({ contextType: 'Case', contextId: CASE, senderContactId: '003000000000001', body: 'Here you go' });
	const upload = () => attachUploadToRequiredFile({ requiredFileId: missing.Id, relatedRecordId: CASE, relatedObjectType: 'Case', bucket: 'b', key: 'k', region: 'r', fileName: 'a.pdf', contentType: 'application/pdf', sizeBytes: 1 });

	it('offers the notification once nothing is outstanding, without changing the status', async () => {
		Object.assign(m, { messages: [team], files: [done, missing] });
		await message();
		expect(await isCaseReadyForTechnician(CASE)).toBe(false);
		await upload();
		expect(await isCaseReadyForTechnician(CASE)).toBe(true);
		expect(moved()).toEqual([]);
	});

	it('saving the reply, a file or onboarding never changes the status by itself', async () => {
		Object.assign(m, { messages: [team], files: [missing], onboardingConfig: CONFIG });
		await message();
		await upload();
		expect((await saveCaseOnboarding(CASE, { ASIN__c: 'B0ABC' })).ok).toBe(true);
		expect(moved()).toEqual([]);
	});

	it('offers nothing when the case is not waiting or cannot be read', async () => {
		Object.assign(m, { status: 'New', messages: [client] });
		expect(await isCaseReadyForTechnician(CASE)).toBe(false);
		Object.assign(m, { status: 'Waiting on Client', fail: /FROM Case_Message__c/ });
		expect(await isCaseReadyForTechnician(CASE)).toBe(false);
	});

	it('Notify technician moves a waiting case, even with something outstanding', async () => {
		Object.assign(m, { messages: [team], files: [missing] });
		expect(await notifyTechnician(CASE)).toEqual({ ok: true });
		expect(moved()).toEqual([{ object: 'Case', id: CASE, body: { Status: 'In Progress - Tech' } }]);
	});

	it('does not move a case that is no longer waiting, and accepts a repeat click', async () => {
		m.status = 'Closed';
		expect(await notifyTechnician(CASE)).toMatchObject({ ok: false, status: 409 });
		m.status = 'In Progress - Tech';
		expect(await notifyTechnician(CASE)).toEqual({ ok: true });
		expect(await notifyTechnician("500' OR Id != '")).toMatchObject({ ok: false, status: 404 });
		expect(moved()).toEqual([]);
	});

	it('reports a Salesforce failure instead of claiming success', async () => {
		m.fail = /FROM Case\b/;
		expect(await notifyTechnician(CASE)).toMatchObject({ ok: false, status: 502 });
		expect(m.logged).toHaveBeenCalledTimes(1);
	});
});
