import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	find: vi.fn(), claim: vi.fn(), release: vi.fn(), record: vi.fn(), store: vi.fn(), avail: vi.fn(), audit: vi.fn(), slot: {} as Record<string, unknown>, slotErr: null as Error | null
}));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db', () => ({ sql: () => Promise.resolve([]) }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: () => ({ errorMessage: 'x', stack: '' }) }));
vi.mock('$lib/server/mcp/killswitch', () => ({ mcpAvailable: m.avail }));
vi.mock('$lib/server/integrations/audit', () => ({ recordIntegrationEvent: m.audit }));
vi.mock('$lib/server/integrations/resources', () => ({
	requireIntegrationStore: async () => ({ id: 'st', account_id: 'acc', sfdc_store_id: 'a0S000000000001' }),
	requireIntegrationCase: async () => {}, requireIntegrationRequiredFile: async () => { if (m.slotErr) throw m.slotErr; return m.slot; }, requireIntegrationStoreRequiredFile: async () => { if (m.slotErr) throw m.slotErr; return m.slot; }
}));
vi.mock('$lib/server/mcp/upload_links', () => ({ findUsableLink: m.find, claimLink: m.claim, releaseLink: m.release, recordLinkUpload: m.record }));
vi.mock('$lib/server/files/required_file_upload', async (orig) => ({ ...(await orig<object>()), storeRequiredFileUpload: m.store }));

import { load, actions } from '../../src/routes/upload/[token]/+page.server';
import { ApiError } from '../../src/lib/server/integrations/errors';

const LINK = { id: 'l1', account_id: 'acc', store_id: 'st', sfdc_case_id: '500Hn00000AbCdEIAV', required_file_id: 'a0Y', replace_existing: false, created_by_user_id: 'u1', integration_id: 'i1', expires_at: new Date(Date.now() + 600000) };
const TOKEN = 'T'.repeat(43);
const setHeaders = vi.fn();
const post = (file?: File) => {
	const fd = new FormData();
	if (file) fd.set('file', file);
	return (actions.upload as any)({ params: { token: TOKEN }, request: { formData: async () => fd }, setHeaders, getClientAddress: () => '1.2.3.4' });
};
const txt = (name = 'notes.txt', body = 'hello') => new File([body], name, { type: 'text/plain' });

beforeEach(() => {
	m.slotErr = null;
	Object.values(m).forEach((f) => typeof f === 'function' && 'mockReset' in f && (f as any).mockReset());
	m.find.mockResolvedValue(LINK);
	m.claim.mockResolvedValue(true);
	m.release.mockResolvedValue(undefined);
	m.record.mockResolvedValue(undefined);
	m.audit.mockResolvedValue(undefined);
	m.avail.mockResolvedValue({ ok: true });
	m.store.mockResolvedValue({ id: 'd1', fileName: 'notes.txt', sizeBytes: 5, contentType: 'text/plain', requiredFileId: 'a0Y', salesforceSynced: true });
	m.slot = { id: 'a0Y', name: 'Notes', shortDescription: 'desc', instructions: '<p>Hi</p>', acceptedFormats: ['txt', 'docx'], uploaded: false };
});

describe('/upload/[token] load', () => {
	it('shows the slot for a usable link and sets no-store headers', async () => {
		const r: any = await (load as any)({ params: { token: TOKEN }, setHeaders });
		expect(r).toMatchObject({ state: 'ready', slotName: 'Notes', acceptedFormats: ['txt', 'docx'], maxMb: 25, instructions: 'Hi' });
		expect(setHeaders).toHaveBeenCalledWith(expect.objectContaining({ 'cache-control': 'no-store' }));
	});
	it('every bad link looks the same (unknown / used / expired)', async () => {
		m.find.mockResolvedValue(null);
		expect(await (load as any)({ params: { token: 'x' }, setHeaders })).toEqual({ state: 'unusable' });
	});
	it('a target that no longer exists is also just "unusable"', async () => {
		m.slotErr = new ApiError(404, 'NOT_FOUND', 'Required file not found.');
		expect(await (load as any)({ params: { token: TOKEN }, setHeaders })).toEqual({ state: 'unusable' });
	});
	it('respects the kill switch', async () => {
		m.avail.mockResolvedValue({ ok: false, reason: 'account' });
		expect(await (load as any)({ params: { token: TOKEN }, setHeaders })).toEqual({ state: 'disabled' });
	});
});

describe('/upload/[token] upload action', () => {
	it('uploads once: claims the link, stores the file as the link creator, audits it', async () => {
		const r: any = await post(txt());
		expect(r).toMatchObject({ done: true, fileName: 'notes.txt', synced: true });
		expect(m.claim).toHaveBeenCalledWith('l1');
		const [target, input] = m.store.mock.calls[0];
		expect(target).toMatchObject({ userId: 'u1', caseId: '500Hn00000AbCdEIAV', slot: { id: 'a0Y' } });
		expect(input).toMatchObject({ contentType: 'text/plain', fileName: 'notes.txt', replaceExisting: false });
		expect(m.record).toHaveBeenCalledWith('l1', 'notes.txt');
		expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ operation: 'upload_link.upload', outcome: 'success', integrationId: 'i1', accountId: 'acc' }));
	});
	it('derives the type from the extension, not from what the browser claims', async () => {
		await post(new File(['hello'], 'notes.txt', { type: 'application/x-evil' }));
		expect(m.store.mock.calls[0][1].contentType).toBe('text/plain');
	});
	it('a wrong format is rejected BEFORE the link is spent', async () => {
		const r: any = await post(new File(['%PDF-1.4'], 'doc.pdf', { type: 'application/pdf' }));
		expect(r.status).toBe(422);
		expect(r.data.error).toContain('txt, docx');
		expect(m.claim).not.toHaveBeenCalled();
		expect(m.store).not.toHaveBeenCalled();
	});
	it('fake content, empty and missing files are rejected without spending the link', async () => {
		m.slot = { ...m.slot, acceptedFormats: ['docx'] };
		expect(((await post(new File(['not a zip'], 'a.docx')) as any).status)).toBe(415);
		expect(((await post(new File([], 'a.txt')) as any).status)).toBe(400);
		expect(((await post()) as any).status).toBe(400);
		expect(m.claim).not.toHaveBeenCalled();
	});
	it('a dead or already-used link is refused', async () => {
		m.find.mockResolvedValue(null);
		expect(((await post(txt())) as any).status).toBe(410);
		m.find.mockResolvedValue(LINK);
		m.claim.mockResolvedValue(false); // lost the race: double submit
		expect(((await post(txt())) as any).status).toBe(410);
		expect(m.store).not.toHaveBeenCalled();
	});
	it('a failed upload hands the link back so the customer can retry', async () => {
		m.store.mockRejectedValue(new ApiError(422, 'MALWARE_DETECTED', 'The file was rejected because it appears to contain malware.'));
		const r: any = await post(txt());
		expect(r.status).toBe(422);
		expect(m.release).toHaveBeenCalledWith('l1');
		expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failure', errorCode: 'MALWARE_DETECTED' }));
	});
	it('an unexpected error is generic to the customer, logged, and releases the link', async () => {
		m.store.mockRejectedValue(new Error('boom: secret detail'));
		const r: any = await post(txt());
		expect(r.status).toBe(500);
		expect(JSON.stringify(r.data)).not.toContain('secret');
		expect(m.release).toHaveBeenCalled();
	});
	it('respects the kill switch', async () => {
		m.avail.mockResolvedValue({ ok: false, reason: 'global' });
		expect(((await post(txt())) as any).status).toBe(503);
		expect(m.claim).not.toHaveBeenCalled();
	});
});
