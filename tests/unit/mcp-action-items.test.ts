import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	env: { ORIGIN: 'https://app.example.com' } as Record<string, string>,
	createLink: vi.fn(),
	slot: {} as Record<string, unknown>
}));

vi.mock('$env/dynamic/private', () => ({ env: m.env }));
vi.mock('$lib/server/db', () => ({ sql: () => Promise.resolve([]) }));
vi.mock('$lib/server/salesforce', () => ({
	attachUploadToRequiredFile: vi.fn(), createCaseMessage: vi.fn(), listCasesForStore: vi.fn(), listCasesForStores: vi.fn(), fetchCase: vi.fn(),
	listCaseMessages: vi.fn(), listRequiredFilesForCase: vi.fn(), listRequiredFilesForStore: vi.fn()
}));
vi.mock('$lib/server/integrations/resources', () => ({
	STORE_COLUMNS: '', requireIntegrationStore: async () => ({ id: '11111111-1111-4111-8111-111111111111', account_id: 'acc', sfdc_store_id: 'a0S000000000001' }),
	requireIntegrationCase: async () => {}, requireIntegrationRequiredFile: async () => m.slot, requireIntegrationStoreRequiredFile: async () => m.slot,
	getUserSfdcContactId: async () => '003000000000001'
}));
vi.mock('$lib/server/storage/s3', () => ({ putObject: vi.fn(), deleteObject: vi.fn(), getRegion: () => 'r' }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: () => ({ errorMessage: 'x', stack: '' }) }));
vi.mock('$lib/server/integrations/idempotency', () => ({ hashRequest: () => 'h', withIdempotency: vi.fn() }));
vi.mock('../../src/lib/server/mcp/upload_links', () => ({ createUploadLink: m.createLink, UPLOAD_LINK_TTL_MS: 15 * 60 * 1000 }));

import { buildActionItems, isClosedStatus, type CaseIn, type StoreIn } from '../../src/lib/server/mcp/action_items';
import { TOOLS } from '../../src/lib/server/mcp/tools';
import { handleRpc } from '../../src/lib/server/mcp/protocol';
import { ApiError } from '../../src/lib/server/integrations/errors';

const store: StoreIn = { id: 's1', name: 'Acme US', spapiStatus: 'connected', missingProfile: [] };
const file = (id: string, over: Record<string, unknown> = {}) => ({
	id, name: `File ${id}`, shortDescription: 'Please provide it', instructions: null, acceptedFormats: ['pdf'], createdAt: '', uploaded: false, upload: null, example: null, ...over
}) as never;
const kase = (over: Partial<CaseIn> = {}): CaseIn => ({ id: '500A', caseNumber: '00001', subject: 'Subj', status: 'Open', storeId: 's1', lastMessage: null, requiredFiles: [], ...over });
const build = (cases: CaseIn[], extra: Partial<{ stores: StoreIn[]; storeFiles: Record<string, never[]> }> = {}) =>
	buildActionItems({ stores: extra.stores ?? [store], storeFiles: extra.storeFiles ?? {}, cases });

describe('isClosedStatus', () => {
	it('treats closed/resolved/cancelled as done, everything else as open', () => {
		for (const s of ['Closed', 'closed - won', 'Resolved', 'Cancelled', 'Completed']) expect(isClosedStatus(s)).toBe(true);
		for (const s of ['Draft', 'Open', 'Waiting on Client', 'In Progress']) expect(isClosedStatus(s)).toBe(false);
	});
});

describe('buildActionItems', () => {
	it('a case waiting on the client needs a reply (urgent) with the right tools', () => {
		const [i] = build([kase({ status: 'Waiting on Client' })]);
		expect(i).toMatchObject({ type: 'reply_needed', priority: 'high', caseNumber: '00001', howToComplete: { tools: ['list_messages', 'post_message'] } });
	});
	it('staff writing last on an open case needs a reply; the customer writing last does not', () => {
		expect(build([kase({ lastMessage: { senderType: 'Internal', createdAt: 'x' } })]).map((i) => i.type)).toEqual(['reply_needed']);
		expect(build([kase({ lastMessage: { senderType: 'External', createdAt: 'x' } })])).toEqual([]);
	});
	it('closed cases produce nothing, even with missing files', () => {
		expect(build([kase({ status: 'Closed', requiredFiles: [file('a')] })])).toEqual([]);
	});
	it('a draft case is flagged and points to the app', () => {
		const [i] = build([kase({ status: 'Draft' })]);
		expect(i).toMatchObject({ type: 'review_draft_case', priority: 'normal', howToComplete: { inApp: expect.stringContaining('submit') } });
	});
	it('missing case files are urgent uploads; uploaded ones are skipped', () => {
		const items = build([kase({ requiredFiles: [file('a'), file('b', { uploaded: true })] })]);
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ id: 'file:a', type: 'upload_required_file', priority: 'high', caseId: '500A', howToComplete: { tools: ['create_upload_link'], arguments: { storeId: 's1', caseId: '500A', requiredFileId: 'a' } } });
	});
	it('text slots also offer pasting; store-level slots are normal priority and carry no caseId', () => {
		const [c] = build([kase({ requiredFiles: [file('t', { acceptedFormats: ['docx', 'txt', 'log'] })] })]);
		expect(c.howToComplete.tools).toEqual(['create_upload_link', 'upload_file']);
		const [s] = build([], { storeFiles: { s1: [file('st')] } });
		expect(s).toMatchObject({ priority: 'normal', storeName: 'Acme US' });
		expect(s.caseId).toBeUndefined();
		expect(s.howToComplete.arguments).toEqual({ storeId: 's1', requiredFileId: 'st' });
	});
	it('store setup gaps are low priority and sorted last', () => {
		const items = build([kase({ status: 'Waiting on Client' })], { stores: [{ ...store, spapiStatus: 'disconnected', missingProfile: ['country'] }] });
		expect(items.map((i) => i.priority)).toEqual(['high', 'low', 'low']);
		expect(items.map((i) => i.type)).toEqual(['reply_needed', 'connect_amazon', 'complete_store_profile']);
	});
	it('strips HTML from slot instructions and caps their length', () => {
		const [i] = build([kase({ requiredFiles: [file('a', { instructions: `<p>Send the <b>invoice</b></p><script>x()</script>${'z'.repeat(1000)}` })] })]);
		const text = String((i.details as { instructions: string }).instructions);
		expect(text).not.toContain('<');
		expect(text.length).toBeLessThanOrEqual(400);
	});
});

describe('create_upload_link', () => {
	const tool = TOOLS.find((t) => t.name === 'create_upload_link')!;
	const p = { accountId: 'acc', defaultUserId: 'u1', integrationId: 'i1', permissions: [] } as never;
	const args = { storeId: '11111111-1111-4111-8111-111111111111', caseId: '500Hn00000AbCdEIAV', requiredFileId: 'a0YHn00000LmNoPQAV' };
	beforeEach(() => {
		m.env.ORIGIN = 'https://app.example.com/';
		m.slot = { id: 'a0YHn00000LmNoPQAV', name: 'ID proof', acceptedFormats: ['pdf'], uploaded: false };
		m.createLink.mockReset().mockResolvedValue({ token: 'T'.repeat(43), expiresAt: new Date('2026-11-24T06:15:00Z') });
	});
	it('returns a one-time URL built from the configured origin, bound to the slot', async () => {
		const r: any = await tool.run(p, args);
		expect(r.url).toBe(`https://app.example.com/upload/${'T'.repeat(43)}`);
		expect(r).toMatchObject({ validForMinutes: 15, slot: { name: 'ID proof' } });
		expect(m.createLink).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'acc', caseId: '500Hn00000AbCdEIAV', requiredFileId: 'a0YHn00000LmNoPQAV', userId: 'u1', integrationId: 'i1', replaceExisting: false }));
	});
	it('refuses a filled slot unless replaceExisting=true', async () => {
		m.slot = { ...m.slot, uploaded: true };
		await expect(tool.run(p, args)).rejects.toMatchObject({ status: 409, code: 'SLOT_ALREADY_UPLOADED' });
		await expect(tool.run(p, { ...args, replaceExisting: true })).resolves.toMatchObject({ url: expect.any(String) });
	});
	it('fails closed without an https public origin', async () => {
		m.env.ORIGIN = '';
		await expect(tool.run(p, args)).rejects.toMatchObject({ status: 503, code: 'NOT_CONFIGURED' });
		m.env.ORIGIN = 'http://insecure.example.com';
		await expect(tool.run(p, args)).rejects.toBeInstanceOf(ApiError);
	});
	it('rate-limits when too many links are open', async () => {
		m.createLink.mockResolvedValue(null);
		await expect(tool.run(p, args)).rejects.toMatchObject({ status: 429 });
	});
	it('rejects malformed ids (not found, no oracle) and is gated by files.upload', async () => {
		await expect(tool.run(p, { ...args, requiredFileId: 'nope' })).rejects.toMatchObject({ status: 404 });
		expect(m.createLink).not.toHaveBeenCalled();
		expect(tool.permission).toBe('files.upload');
	});
});

describe('get_action_items + prompts wiring', () => {
	const rpc = (method: string, params: unknown, perms: string[]) => handleRpc({ jsonrpc: '2.0', id: 1, method, params: params as never }, { permissions: perms } as never, {}) as Promise<any>;
	it('get_action_items is a read tool behind stores.list', () => {
		const t = TOOLS.find((x) => x.name === 'get_action_items')!;
		expect(t.permission).toBe('stores.list');
		expect(t.annotations.readOnlyHint).toBe(true);
	});
	it('advertises prompts and lists only the ones the connection may use', async () => {
		const init = await rpc('initialize', { protocolVersion: '2025-06-18' }, []);
		expect(init.result.capabilities.prompts).toBeDefined();
		expect(init.result.instructions).toContain('get_action_items');
		expect((await rpc('prompts/list', {}, ['stores.list'])).result.prompts.map((x: { name: string }) => x.name)).toEqual(['whats_needed']);
		expect((await rpc('prompts/list', {}, ['stores.list', 'files.upload'])).result.prompts.map((x: { name: string }) => x.name)).toEqual(['whats_needed', 'upload_document']);
		expect((await rpc('prompts/list', {}, [])).result.prompts).toEqual([]);
	});
	it('prompts/get returns a user message, and refuses unknown or forbidden prompts', async () => {
		const ok = await rpc('prompts/get', { name: 'whats_needed' }, ['stores.list']);
		expect(ok.result.messages[0]).toMatchObject({ role: 'user', content: { type: 'text', text: expect.stringContaining('get_action_items') } });
		expect((await rpc('prompts/get', { name: 'upload_document' }, ['stores.list'])).error.code).toBe(-32602);
		expect((await rpc('prompts/get', { name: 'nope' }, ['stores.list'])).error.code).toBe(-32602);
	});
});
