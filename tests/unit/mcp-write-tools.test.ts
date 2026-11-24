import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({ put: vi.fn(), attach: vi.fn(), createMsg: vi.fn(), slot: {} as Record<string, unknown> }));

vi.mock('$env/dynamic/private', () => ({ env: {} }));
vi.mock('$lib/server/db', () => ({ sql: () => Promise.resolve([]) }));
vi.mock('$lib/server/storage/s3', () => ({ putObject: m.put, deleteObject: async () => {}, getRegion: () => 'us-east-1' }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: () => ({ errorMessage: 'x', stack: '' }) }));
vi.mock('$lib/server/salesforce', () => ({
	attachUploadToRequiredFile: m.attach, createCaseMessage: m.createMsg,
	listCasesForStore: vi.fn(), fetchCase: vi.fn(), listCaseMessages: vi.fn(), listRequiredFilesForCase: vi.fn(), listRequiredFilesForStore: vi.fn()
}));
vi.mock('$lib/server/integrations/resources', () => ({
	STORE_COLUMNS: '', requireIntegrationStore: async () => ({ id: '11111111-1111-4111-8111-111111111111', account_id: 'acc', sfdc_store_id: 'a0S000000000001' }),
	requireIntegrationCase: async () => {}, requireIntegrationRequiredFile: async () => m.slot, requireIntegrationStoreRequiredFile: async () => m.slot,
	getUserSfdcContactId: async () => '003000000000001'
}));
vi.mock('$lib/server/integrations/idempotency', () => ({
	hashRequest: () => 'h'.repeat(64), withIdempotency: async (_i: string, _o: string, _k: string, _h: string, fn: () => Promise<{ status: number; body: unknown }>) => ({ ...(await fn()), replayed: false })
}));

import { TOOLS } from '../../src/lib/server/mcp/tools';

const STORE = '11111111-1111-4111-8111-111111111111';
const CASE = '500Hn00000AbCdEIAV';
const SLOT = 'a0YHn00000LmNoPQAV';
const p = { accountId: 'acc', defaultUserId: 'u1', integrationId: 'i1', permissions: [] } as never;
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const pdfB64 = Buffer.from('%PDF-1.4 test').toString('base64');
const upload = (over: Record<string, unknown> = {}) => ({ storeId: STORE, caseId: CASE, requiredFileId: SLOT, fileName: 'id.pdf', contentType: 'application/pdf', contentBase64: pdfB64, ...over });

beforeEach(() => {
	m.put.mockReset().mockResolvedValue({ bucket: 'b' });
	m.attach.mockReset().mockResolvedValue({ ok: true, s3DocumentId: 's3' });
	m.createMsg.mockReset().mockResolvedValue({ ok: true, id: 'a0XHn00000QrStUMAV' });
	m.slot = { id: SLOT, name: 'ID proof', acceptedFormats: ['pdf'], uploaded: false };
});

describe('write tools are flagged for client approval', () => {
	it('read tools are readOnly, write tools are not', () => {
		for (const t of TOOLS) expect(t.annotations.readOnlyHint).toBe(!['upload_file', 'post_message'].includes(t.name));
	});
});

describe('upload_file', () => {
	it('only previews without confirm — nothing is stored', async () => {
		const r: any = await tool('upload_file').run(p, upload());
		expect(r).toMatchObject({ preview: true, wouldUpload: { fileName: 'id.pdf', scope: 'case', slot: { name: 'ID proof' } } });
		expect(m.put).not.toHaveBeenCalled();
	});
	it('uploads with confirm=true', async () => {
		const r: any = await tool('upload_file').run(p, upload({ confirm: true }));
		expect(r).toMatchObject({ uploaded: true, fileName: 'id.pdf', salesforceSynced: true });
		expect(m.put).toHaveBeenCalledTimes(1);
	});
	it('uses the store-level path when caseId is omitted', async () => {
		await tool('upload_file').run(p, upload({ caseId: undefined, confirm: true }));
		expect(m.put.mock.calls[0][0]).toContain('/Documents/');
	});
	it('applies the REST rules: wrong format, filled slot, fake content, bad base64', async () => {
		m.slot = { ...m.slot, acceptedFormats: ['png'] };
		await expect(tool('upload_file').run(p, upload())).rejects.toMatchObject({ code: 'FORMAT_NOT_ACCEPTED' });
		m.slot = { ...m.slot, acceptedFormats: ['pdf'], uploaded: true };
		await expect(tool('upload_file').run(p, upload({ confirm: true }))).rejects.toMatchObject({ code: 'SLOT_ALREADY_UPLOADED' });
		await expect(tool('upload_file').run(p, upload({ replaceExisting: true, contentBase64: Buffer.from('not a pdf').toString('base64') }))).rejects.toMatchObject({ code: 'CONTENT_MISMATCH' });
		await expect(tool('upload_file').run(p, upload({ contentBase64: '***' }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
		expect(m.put).not.toHaveBeenCalled();
	});
	it('rejects files over the MCP size limit before decoding', async () => {
		const big = 'A'.repeat(8 * 1024 * 1024);
		await expect(tool('upload_file').run(p, upload({ contentBase64: big }))).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
	});
});

describe('post_message', () => {
	const args = (over: Record<string, unknown> = {}) => ({ storeId: STORE, caseId: CASE, body: '<p>Hello <script>x()</script>team</p>', ...over });
	it('previews the sanitised text without posting', async () => {
		const r: any = await tool('post_message').run(p, args());
		expect(r.preview).toBe(true);
		expect(r.wouldPost.text).not.toContain('script');
		expect(m.createMsg).not.toHaveBeenCalled();
	});
	it('posts with confirm=true as the connection user', async () => {
		const r: any = await tool('post_message').run(p, args({ confirm: true }));
		expect(r).toMatchObject({ posted: true, id: 'a0XHn00000QrStUMAV' });
		expect(m.createMsg.mock.calls[0][0]).toMatchObject({ caseId: CASE, senderContactId: '003000000000001' });
		expect(m.createMsg.mock.calls[0][1]).toMatchObject({ userId: 'u1', accountId: 'acc' });
	});
	it('rejects empty bodies', async () => {
		await expect(tool('post_message').run(p, args({ body: '   ' }))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
	});
});
