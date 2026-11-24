import { describe, it, expect, vi, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	env: { ORIGIN: 'https://app.example.com/' } as Record<string, string>,
	rows: [] as unknown[],
	messages: [] as unknown[]
}));

vi.mock('$env/dynamic/private', () => ({ env: m.env }));
vi.mock('$lib/server/db', () => ({ sql: () => Promise.resolve(m.rows) }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: () => ({ errorMessage: 'x', stack: '' }) }));
vi.mock('$lib/server/storage/s3', () => ({ putObject: vi.fn(), deleteObject: vi.fn(), getRegion: () => 'r' }));
vi.mock('$lib/server/integrations/idempotency', () => ({ hashRequest: () => 'h', withIdempotency: vi.fn() }));
vi.mock('$lib/server/salesforce', () => ({
	attachUploadToRequiredFile: vi.fn(), createCaseMessage: vi.fn(), fetchCase: vi.fn(), listCasesForStores: vi.fn(),
	listCasesForStore: async () => ({ ok: true, cases: [{ Id: '500A', CaseNumber: '00001', Subject: 's', Status: 'Open', Priority: null, CreatedDate: 'c', LastModifiedDate: 'u', recordTypeName: null }] }),
	listCaseMessages: async () => ({ ok: true, messages: m.messages }),
	listRequiredFilesForCase: async () => ({ ok: true, files: [{ id: 'a0Y', name: 'Doc', shortDescription: null, instructions: null, acceptedFormats: ['pdf'], createdAt: '', uploaded: false, upload: null, example: null }] }),
	listRequiredFilesForStore: async () => ({ ok: true, files: [{ id: 'a0Z', name: 'Store doc', shortDescription: null, instructions: null, acceptedFormats: ['pdf'], createdAt: '', uploaded: false, upload: null, example: null }] })
}));
const STORE = { id: '11111111-1111-4111-8111-111111111111', account_id: 'acc', sfdc_store_id: 'a0S000000000001', name: 'Acme', marketplaces: 'US;UK', seller_id: null, seller_primary_email: null, store_email: null, business_name: null, country: null, description: null, spapi_status: 'connected', created_at: new Date(0), updated_at: new Date(0) };
vi.mock('$lib/server/integrations/resources', () => ({
	STORE_COLUMNS: '', requireIntegrationStore: async () => STORE, requireIntegrationCase: async () => {},
	requireIntegrationRequiredFile: vi.fn(), requireIntegrationStoreRequiredFile: vi.fn(), getUserSfdcContactId: async () => 'c'
}));

import { makeLinks, withUrl, mdLink } from '../../src/lib/server/mcp/links';
import { buildActionItems, checklistMarkdown, type StoreIn, type CaseIn } from '../../src/lib/server/mcp/action_items';
import { TOOLS } from '../../src/lib/server/mcp/tools';

const p = { accountId: 'acc', defaultUserId: 'u', integrationId: 'i', permissions: [] } as never;
const tool = (n: string) => TOOLS.find((t) => t.name === n)!;
const CASE = '500Hn00000AbCdEIAV';
const O = 'https://app.example.com';

beforeEach(() => { m.env.ORIGIN = 'https://app.example.com/'; m.rows = [STORE]; });

describe('deep links', () => {
	it('point at the real app pages and escape ids', () => {
		const L = makeLinks(O);
		expect(L.store('s 1')).toBe(`${O}/stores/s%201`);
		expect(L.case('s1', '500A')).toBe(`${O}/stores/s1/issues/500A`);
		expect(L.storeDocuments('s1')).toBe(`${O}/stores/s1#store-documents`);
		expect(L.storeMessages('s1')).toBe(`${O}/stores/s1#store-messages`);
	});
	it('produce nothing without an https origin — never a broken or http link', () => {
		expect(makeLinks(null).store('s1')).toBeUndefined();
		m.env.ORIGIN = 'http://insecure.example.com';
		expect(makeLinks().store('s1')).toBeUndefined();
		m.env.ORIGIN = '';
		expect(makeLinks().case('s', 'c')).toBeUndefined();
		expect(withUrl({ a: 1 }, undefined)).toEqual({ a: 1 });
	});
	it('markdown labels cannot break out of the link', () => {
		expect(mdLink('Case [1]\nx', `${O}/c`)).toBe(`[Case  1  x](${O}/c)`);
		expect(mdLink('Plain', undefined)).toBe('Plain');
	});
});

const store: StoreIn = { id: 's1', name: 'Acme', spapiStatus: 'disconnected', missingProfile: ['country'] };
const file = (id: string) => ({ id, name: `File ${id}`, shortDescription: 'why', instructions: null, acceptedFormats: ['pdf'], createdAt: '', uploaded: false, upload: null, example: null }) as never;
const kase = (over: Partial<CaseIn> = {}): CaseIn => ({ id: '500A', caseNumber: '00001', subject: null, status: 'Waiting on Client', storeId: 's1', lastMessage: null, requiredFiles: [file('a')], ...over });

describe('action items carry links', () => {
	const items = buildActionItems({ stores: [store], storeFiles: { s1: [file('st')] }, cases: [kase()], origin: O });
	const by = (id: string) => items.find((i) => i.id === id)!;
	it('case items open the case, store-level documents jump to the documents card, setup items open the store', () => {
		expect(by('reply:500A').url).toBe(`${O}/stores/s1/issues/500A`);
		expect(by('file:a').url).toBe(`${O}/stores/s1/issues/500A`);
		expect(by('file:st').url).toBe(`${O}/stores/s1#store-documents`);
		expect(by('amazon:s1').url).toBe(`${O}/stores/s1`);
		expect(by('profile:s1').url).toBe(`${O}/stores/s1`);
	});
	it('no origin → no url field at all', () => {
		for (const i of buildActionItems({ stores: [store], storeFiles: {}, cases: [kase()] })) expect('url' in i).toBe(false);
	});
	it('the checklist is grouped by priority with clickable titles', () => {
		const md = checklistMarkdown(items);
		expect(md.indexOf('**Urgent**')).toBeLessThan(md.indexOf('**To do**'));
		expect(md.indexOf('**To do**')).toBeLessThan(md.indexOf('**Optional**'));
		expect(md).toContain(`- [Reply on case 00001](${O}/stores/s1/issues/500A) —`);
		expect(md).toContain(`(${O}/stores/s1#store-documents)`);
		expect(checklistMarkdown([])).toBe('Nothing needs your attention right now.');
	});
});

describe('tools return a url for every record', () => {
	it('stores, cases and files', async () => {
		const stores: any = await tool('list_stores').run(p, {});
		expect(stores.data[0].url).toBe(`${O}/stores/${STORE.id}`);
		expect((await tool('get_store').run(p, { storeId: STORE.id }) as any).data.url).toBe(`${O}/stores/${STORE.id}`);
		const cases: any = await tool('list_cases').run(p, { storeId: STORE.id });
		expect(cases.data[0].url).toBe(`${O}/stores/${STORE.id}/issues/500A`);
		const caseFiles: any = await tool('list_required_files').run(p, { storeId: STORE.id, caseId: CASE });
		expect(caseFiles.data[0].url).toBe(`${O}/stores/${STORE.id}/issues/${CASE}`);
		const storeFiles: any = await tool('list_required_files').run(p, { storeId: STORE.id });
		expect(storeFiles.data[0].url).toBe(`${O}/stores/${STORE.id}#store-documents`);
	});
	it('tools still work (without urls) when no public origin is configured', async () => {
		m.env.ORIGIN = '';
		const stores: any = await tool('list_stores').run(p, {});
		expect(stores.data[0].name).toBe('Acme');
		expect('url' in stores.data[0]).toBe(false);
	});
});

describe('list_messages is readable', () => {
	it('returns plain text with real line breaks, who wrote it, and the case link', async () => {
		m.messages = [
			{ Id: 'a0N1', body: 'Hello<br />second line<p>para</p><script>alert(1)</script>', senderType: 'External', displayName: 'Pat', replyToMessageId: null, createdAt: '2026-11-20T03:50:22.000+0000' },
			{ Id: 'a0N2', body: 'We are on it &amp; will update', senderType: 'Internal', displayName: 'Support', replyToMessageId: 'a0N1', createdAt: '2026-11-23T02:44:41.000+0000' }
		];
		const r: any = await tool('list_messages').run(p, { storeId: STORE.id, caseId: CASE });
		expect(r.url).toBe(`${O}/stores/${STORE.id}/issues/${CASE}`);
		expect(r.data[0]).toEqual({ id: 'a0N1', text: expect.stringContaining('Hello\nsecond line'), fromOurTeam: false, sender: 'Pat', replyToMessageId: null, createdAt: '2026-11-20T03:50:22.000+0000' });
		expect(r.data[0].text).not.toMatch(/<|alert\(1\)/);
		expect(r.data[0]).not.toHaveProperty('body');
		expect(r.data[1]).toMatchObject({ fromOurTeam: true, replyToMessageId: 'a0N1' });
		expect(r.data[1].text).toContain('&');
	});
});
