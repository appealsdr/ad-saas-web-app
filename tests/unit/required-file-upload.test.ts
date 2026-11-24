import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ put: vi.fn(), del: vi.fn(), attach: vi.fn(), rows: [] as unknown[] }));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db', () => ({ sql: (...a: unknown[]) => { m.rows.push(a); return Promise.resolve([]); } }));
vi.mock('$lib/server/storage/s3', () => ({ putObject: m.put, deleteObject: m.del, getRegion: () => 'us-east-1' }));
vi.mock('$lib/server/salesforce', () => ({ attachUploadToRequiredFile: m.attach }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: () => ({ errorMessage: 'x', stack: '' }) }));

import { validateUpload, storeRequiredFileUpload, contentMatchesMime, MAX_UPLOAD_BYTES } from '../../src/lib/server/files/required_file_upload';
import { ApiError } from '../../src/lib/server/integrations/errors';

const slot = (over: Record<string, unknown> = {}) => ({
	id: 'a0YHn00000LmNoPQAV', name: 'ID', shortDescription: null, instructions: null, acceptedFormats: ['pdf'],
	createdAt: '', uploaded: false, upload: null, example: null, ...over
}) as never;
const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const input = (over: Record<string, unknown> = {}) => ({ contentType: 'application/pdf', fileName: 'id.pdf', bytes: pdf, replaceExisting: false, ...over }) as never;
const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { return e instanceof ApiError ? `${e.status}:${e.code}` : 'other'; } };

describe('validateUpload', () => {
	it('accepts a matching pdf', () => expect(code(() => validateUpload(slot(), input()))).toBe('ok'));
	it('rejects unknown MIME, extension mismatch, wrong slot format', () => {
		expect(code(() => validateUpload(slot(), input({ contentType: 'application/x-msdownload', fileName: 'a.exe' })))).toBe('415:UNSUPPORTED_MEDIA_TYPE');
		expect(code(() => validateUpload(slot(), input({ fileName: 'id.png' })))).toBe('422:VALIDATION_ERROR');
		expect(code(() => validateUpload(slot({ acceptedFormats: ['png', 'jpg'] }), input()))).toBe('422:FORMAT_NOT_ACCEPTED');
	});
	it('treats jpeg and jpg as the same accepted format', () => {
		const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
		expect(code(() => validateUpload(slot({ acceptedFormats: ['jpg'] }), input({ contentType: 'image/jpeg', fileName: 'a.jpeg', bytes: jpg })))).toBe('ok');
	});
	it('rejects content that is not the declared type, empty and oversized files', () => {
		expect(code(() => validateUpload(slot(), input({ bytes: new Uint8Array([1, 2, 3, 4]) })))).toBe('415:CONTENT_MISMATCH');
		expect(code(() => validateUpload(slot(), input({ bytes: new Uint8Array(0) })))).toBe('422:VALIDATION_ERROR');
		expect(code(() => validateUpload(slot(), input({ bytes: new Uint8Array(MAX_UPLOAD_BYTES + 1) })))).toBe('413:PAYLOAD_TOO_LARGE');
	});
	it('refuses to touch a filled slot unless replaceExisting is set', () => {
		expect(code(() => validateUpload(slot({ uploaded: true }), input()))).toBe('409:SLOT_ALREADY_UPLOADED');
		expect(code(() => validateUpload(slot({ uploaded: true }), input({ replaceExisting: true })))).toBe('ok');
	});
	it('rejects text files containing NUL bytes', () => {
		expect(contentMatchesMime(new Uint8Array([104, 105]), 'text/plain')).toBe(true);
		expect(contentMatchesMime(new Uint8Array([104, 0, 105]), 'text/csv')).toBe(false);
	});
});

describe('storeRequiredFileUpload', () => {
	beforeEach(() => { m.put.mockReset().mockResolvedValue({ bucket: 'b' }); m.del.mockReset(); m.attach.mockReset().mockResolvedValue({ ok: true, s3DocumentId: 's3' }); m.rows.length = 0; });
	const store = { id: 's1', account_id: 'acc1', sfdc_store_id: 'a0S000000000001' };

	it('stores a case-level file under the account/store/case path and links it in Salesforce', async () => {
		const r = await storeRequiredFileUpload({ store, caseId: '500Hn00000AbCdEIAV', userId: 'u1', slot: slot() }, input());
		expect(r).toMatchObject({ requiredFileId: 'a0YHn00000LmNoPQAV', fileName: 'id.pdf', contentType: 'application/pdf', salesforceSynced: true });
		expect(m.put.mock.calls[0][0]).toContain('/Accounts/acc1/Stores/s1/Issues/500Hn00000AbCdEIAV/Files/');
		expect(m.attach.mock.calls[0][0]).toMatchObject({ relatedObjectType: 'Case', relatedRecordId: '500Hn00000AbCdEIAV' });
	});
	it('stores a store-level file against Store__c', async () => {
		await storeRequiredFileUpload({ store, userId: 'u1', slot: slot() }, input());
		expect(m.put.mock.calls[0][0]).toContain('/Stores/s1/Documents/');
		expect(m.attach.mock.calls[0][0]).toMatchObject({ relatedObjectType: 'Store__c', relatedRecordId: 'a0S000000000001' });
	});
	it('reports a Salesforce link failure without losing the file', async () => {
		m.attach.mockResolvedValue({ ok: false, error: 'boom' });
		const r = await storeRequiredFileUpload({ store, userId: 'u1', slot: slot() }, input());
		expect(r).toMatchObject({ salesforceSynced: false, salesforceError: 'boom' });
		expect(m.del).not.toHaveBeenCalled();
	});
	it('does not write anything when validation fails', async () => {
		await expect(storeRequiredFileUpload({ store, userId: 'u1', slot: slot() }, input({ fileName: 'x.png' }))).rejects.toBeInstanceOf(ApiError);
		expect(m.put).not.toHaveBeenCalled();
	});
});
