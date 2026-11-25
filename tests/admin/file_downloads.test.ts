import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Row = Record<string, unknown>;
const m = vi.hoisted(() => ({
	cases: new Map<string, string>(), // case id → Salesforce store id
	slots: new Map<string, Row[]>(), // parent (case or store) id → Required_File__c slots
	exampleRows: [] as Row[],
	queries: [] as string[]
}));
vi.mock('$lib/server/salesforce', () => ({
	findCaseStoreLookup: async (id: string) =>
		m.cases.has(id) ? { ok: true, sfdcCaseId: id, sfdcStoreId: m.cases.get(id) } : { ok: false, notFound: true },
	listRequiredFilesForCase: async (id: string) => ({ ok: true, files: m.slots.get(id) ?? [] }),
	listRequiredFilesForStore: async (id: string) => ({ ok: true, files: m.slots.get(id) ?? [] }),
	listCasesForStore: vi.fn(), fetchCase: vi.fn(), listCaseMessages: vi.fn(), createCaseMessage: vi.fn(),
	attachUploadToRequiredFile: vi.fn(), listCasesForStores: vi.fn(),
	sfdcQuery: async (soql: string) => { m.queries.push(soql); return { records: m.exampleRows, done: true, totalSize: m.exampleRows.length }; }
}));

import { sql } from '$lib/server/db';
import { hasDb, makeAccount, makeUser, makeStore, uniq } from '../setup/db';
import { createIntegration, getIntegration } from '$lib/server/integrations/service';
import { MIME_EXTENSIONS } from '$lib/server/files/required_file_upload';
import { handleRpc } from '$lib/server/mcp/protocol';
import { requireIntegrationPermission } from '$lib/server/integrations/auth';
import { GET as storeFile } from '../../src/routes/api/v1/stores/[storeId]/required-files/[requiredFileId]/file/+server';
import { GET as storeExample } from '../../src/routes/api/v1/stores/[storeId]/required-files/[requiredFileId]/example/+server';
import { GET as caseFile } from '../../src/routes/api/v1/stores/[storeId]/cases/[caseId]/required-files/[requiredFileId]/file/+server';
import { GET as caseExample } from '../../src/routes/api/v1/stores/[storeId]/cases/[caseId]/required-files/[requiredFileId]/example/+server';
import { GET as webExample } from '../../src/routes/api/files/example/[s3DocId]/+server';

const ctx = { actor: { userId: null, ref: 'tester@example.test', role: 'platform_admin' } };
const sfId = (prefix: string) => (prefix + uniq() + '000000000000000000').slice(0, 18);
const version = (fileName: string, contentType: string | null, over: Row = {}) => ({
	s3DocumentId: sfId('a0D'), fileName, fileExtension: null, contentType, s3Key: `accounts/x/${uniq()}/obj`, s3Bucket: 'b', uploadedDate: null, ...over
});
const slot = (over: Row = {}) => ({
	id: sfId('a0R'), name: 'Slot', shortDescription: null, instructions: null, acceptedFormats: [], createdAt: '', uploaded: false, upload: null, example: null, ...over
}) as Row & { id: string };

const uploads = mkdtempSync(join(tmpdir(), 'ad-uploads-'));
beforeAll(() => {
	Object.assign(process.env, {
		AWS_S3_BUCKET: 'test-bucket', AWS_REGION: 'us-east-2', AWS_ACCESS_KEY_ID: 'AKIATESTTESTTEST', AWS_SECRET_ACCESS_KEY: 'test-secret',
		UPLOADS_DIR: uploads, ORIGIN: 'https://app.example.test'
	});
});
beforeEach(() => { m.queries.length = 0; m.exampleRows = []; });

async function world(permissions: string[] = ['files.download']) {
	const account = await makeAccount();
	const user = await makeUser({ accountId: account.id });
	const storeId = await makeStore(account.id);
	const sfStore = sfId('a0S');
	await sql`UPDATE stores SET sfdc_store_id = ${sfStore} WHERE id = ${storeId}`;
	const caseId = sfId('500');
	m.cases.set(caseId, sfStore);
	const integration = await createIntegration(ctx, account.id, { name: `I ${uniq()}`, defaultUserId: user.id, permissions });
	return { account, user, storeId, sfStore, caseId, integration };
}
type World = Awaited<ReturnType<typeof world>>;

function call(handler: unknown, w: World, params: Record<string, string>, query = '') {
	const url = new URL(`https://app.example.test/api/v1/x${query}`);
	const request = new Request(url, { headers: { authorization: `Bearer ${w.integration.rawKey}` } });
	return (handler as (e: unknown) => Promise<Response>)({ request, url, params, locals: {}, getClientAddress: () => '127.0.0.1' });
}
const signed = (res: Response) => new URL(res.headers.get('location')!);
const events = (w: World) => sql<Row[]>`SELECT * FROM integration_audit_events WHERE integration_client_id = ${w.integration.id} AND event_type = 'api_request' ORDER BY occurred_at`;

const d = describe.skipIf(!hasDb);

d('downloading through /api/v1', () => {
	it('redirects to a presigned link for every uploadable type, with its type and name', async () => {
		const w = await world();
		const types = Object.entries(MIME_EXTENSIONS).flatMap(([mime, exts]) => exts.map((ext) => [mime, ext]));
		for (const [mime, ext] of types) {
			const s = slot({ upload: version(`Datei ü.${ext}`, mime), uploaded: true });
			m.slots.set(w.sfStore, [s]);
			const res = await call(storeFile, w, { storeId: w.storeId, requiredFileId: s.id });
			expect(res.status, ext).toBe(302);
			const url = signed(res);
			expect(url.hostname).toContain('test-bucket');
			expect(url.searchParams.get('response-content-type'), ext).toBe(mime);
			expect(url.searchParams.get('response-content-disposition')).toBe(`attachment; filename="Datei _.${ext}"; filename*=UTF-8''Datei%20%C3%BC.${ext}`);
			expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
		}
	});

	it('serves files added in Salesforce with no local row or stored type, on all four endpoints', async () => {
		const w = await world();
		const s = slot({ upload: version('scan.heic', null), example: version('sample.svg', 'image/svg+xml'), uploaded: true });
		const c = slot({ upload: version('unknown.bin', null), example: version('guide.pdf', 'application/pdf') });
		m.slots.set(w.sfStore, [s]);
		m.slots.set(w.caseId, [c]);
		const check = async (h: unknown, params: Record<string, string>, type: string, disposition: string, query = '') => {
			const res = await call(h, w, params, query);
			expect(res.status).toBe(302);
			expect(signed(res).searchParams.get('response-content-type')).toBe(type);
			expect(signed(res).searchParams.get('response-content-disposition')!.split(';')[0]).toBe(disposition);
		};
		const sp = { storeId: w.storeId, requiredFileId: s.id };
		const cp = { storeId: w.storeId, caseId: w.caseId, requiredFileId: c.id };
		await check(storeFile, sp, 'image/heic', 'attachment');
		await check(storeFile, sp, 'image/heic', 'inline', '?disposition=inline');
		await check(storeExample, sp, 'image/svg+xml', 'attachment', '?disposition=inline'); // SVG is never inline
		await check(caseFile, cp, 'application/octet-stream', 'attachment', '?disposition=inline');
		await check(caseExample, cp, 'application/pdf', 'inline', '?disposition=inline');
		await check(caseExample, cp, 'application/pdf', 'attachment');
	});

	it('falls back to local rows: S3 uploads not yet in Salesforce, and legacy files on disk', async () => {
		const w = await world();
		const s3Slot = slot();
		const diskSlot = slot();
		const escape = slot();
		m.slots.set(w.sfStore, [s3Slot, diskSlot, escape]);
		await sql`INSERT INTO store_documents (store_id, original_name, s3_bucket, s3_key, mime_type, size_bytes, sfdc_case_file_id, created_at)
		          VALUES (${w.storeId}, 'old.pdf', 'b', 'k/old', 'application/pdf', 1, ${s3Slot.id}, now() - interval '1 day'),
		                 (${w.storeId}, 'new.pdf', 'b', 'k/new', 'application/pdf', 1, ${s3Slot.id}, now())`;
		const res = await call(storeFile, w, { storeId: w.storeId, requiredFileId: s3Slot.id });
		expect(signed(res).pathname).toBe('/k/new');

		writeFileSync(join(uploads, 'legacy.html'), '<script>1</script>');
		await sql`INSERT INTO store_documents (store_id, original_name, storage_path, mime_type, size_bytes, sfdc_case_file_id)
		          VALUES (${w.storeId}, 'Übersicht.html', 'legacy.html', 'text/html', 18, ${diskSlot.id}),
		                 (${w.storeId}, 'x.txt', '../../etc/hosts', 'text/plain', 1, ${escape.id})`;
		const disk = await call(storeFile, w, { storeId: w.storeId, requiredFileId: diskSlot.id }, '?disposition=inline');
		expect(disk.status).toBe(200);
		expect(disk.headers.get('content-type')).toBe('text/html');
		expect(disk.headers.get('content-disposition')).toBe(`attachment; filename="_bersicht.html"; filename*=UTF-8''%C3%9Cbersicht.html`);
		expect(disk.headers.get('x-content-type-options')).toBe('nosniff');
		expect(await disk.text()).toBe('<script>1</script>');
		expect((await call(storeFile, w, { storeId: w.storeId, requiredFileId: escape.id })).status).toBe(404);

		const caseSlot = slot();
		m.slots.set(w.caseId, [caseSlot]);
		await sql`INSERT INTO case_documents (store_id, sfdc_case_id, original_name, s3_bucket, s3_key, mime_type, size_bytes, sfdc_case_file_id)
		          VALUES (${w.storeId}, ${w.caseId}, 'c.zip', 'b', 'k/case', NULL, 1, ${caseSlot.id})`;
		const c = await call(caseFile, w, { storeId: w.storeId, caseId: w.caseId, requiredFileId: caseSlot.id });
		expect([signed(c).pathname, signed(c).searchParams.get('response-content-type')]).toEqual(['/k/case', 'application/zip']);
	});

	it('answers 404 for a wrong store, case or slot, and for a slot without that file', async () => {
		const w = await world();
		const other = await world();
		const mine = slot({ upload: version('a.pdf', 'application/pdf') });
		const theirs = slot({ upload: version('b.pdf', 'application/pdf') });
		const onCase = slot({ upload: version('c.pdf', 'application/pdf') });
		m.slots.set(w.sfStore, [mine]);
		m.slots.set(other.sfStore, [theirs]);
		m.slots.set(w.caseId, [onCase]);
		const cases: [unknown, Record<string, string>][] = [
			[storeFile, { storeId: other.storeId, requiredFileId: theirs.id }], // another account's store
			[storeFile, { storeId: w.storeId, requiredFileId: theirs.id }], // another store's slot
			[storeFile, { storeId: w.storeId, requiredFileId: onCase.id }], // a case slot at store level
			[storeFile, { storeId: w.storeId, requiredFileId: mine.upload ? (mine.upload as { s3DocumentId: string }).s3DocumentId : '' }], // a raw document id
			[storeFile, { storeId: w.storeId, requiredFileId: "a' OR Id != '" }],
			[storeFile, { storeId: 'nope', requiredFileId: mine.id }],
			[caseFile, { storeId: w.storeId, caseId: other.caseId, requiredFileId: onCase.id }], // another account's case
			[caseFile, { storeId: w.storeId, caseId: sfId('500'), requiredFileId: onCase.id }],
			[caseFile, { storeId: w.storeId, caseId: w.caseId, requiredFileId: mine.id }], // a store slot on a case
			[storeExample, { storeId: w.storeId, requiredFileId: mine.id }] // no example
		];
		for (const [h, params] of cases) {
			const res = await call(h, w, params);
			expect(res.status, JSON.stringify(params)).toBe(404);
			expect(res.headers.get('location')).toBeNull();
		}
		const empty = slot();
		m.slots.set(w.sfStore, [empty]);
		expect((await (await call(storeFile, w, { storeId: w.storeId, requiredFileId: empty.id })).json()).error.code).toBe('FILE_NOT_FOUND');
	});

	it('needs files.download — reading requirements or uploading is not enough', async () => {
		const w = await world(['files.requirements.read', 'files.upload']);
		const s = slot({ upload: version('a.pdf', 'application/pdf') });
		m.slots.set(w.sfStore, [s]);
		const res = await call(storeFile, w, { storeId: w.storeId, requiredFileId: s.id });
		expect(res.status).toBe(403);
		expect((await res.json()).error.code).toBe('PERMISSION_DENIED');
	});

	it('audits each download without the presigned link', async () => {
		const w = await world();
		const s = slot({ upload: version('a.pdf', 'application/pdf') });
		m.slots.set(w.sfStore, [s]);
		await call(storeFile, w, { storeId: w.storeId, requiredFileId: s.id });
		const [e] = await events(w);
		expect(e).toMatchObject({ operation: 'store_required_files.download_upload', resource_type: 'required_file', resource_id: s.id, outcome: 'success', http_status: 302, required_permission: 'files.download' });
		expect(e.metadata).toMatchObject({ storeId: w.storeId, fileName: 'a.pdf', storage: 's3' });
		expect(JSON.stringify(e)).not.toMatch(/X-Amz|amazonaws/);
	});
});

d('MCP get_download_link', () => {
	const run = async (w: World, args: Row) => {
		const principal = await requireIntegrationPermission(new Request('https://app.example.test/mcp', { headers: { authorization: `Bearer ${w.integration.rawKey}` } }), null);
		const audit: Row = {};
		const res = (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_download_link', arguments: args } }, principal, audit)) as { result: { isError: boolean; content: { text: string }[] } };
		return { isError: res.result.isError, body: JSON.parse(res.result.content[0].text), audit };
	};

	it('returns a link with name, type and expiry for upload and example files', async () => {
		const w = await world();
		const s = slot({ upload: version('a.docx', null), example: version('e.pdf', 'application/pdf') });
		m.slots.set(w.caseId, [s]);
		const before = Date.now();
		const up = await run(w, { storeId: w.storeId, caseId: w.caseId, requiredFileId: s.id });
		expect(up.body).toMatchObject({ fileName: 'a.docx', contentType: MIME_EXTENSIONS && 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
		expect(new URL(up.body.url).searchParams.get('X-Amz-Signature')).toBeTruthy();
		const ttl = Date.parse(up.body.expiresAt) - before;
		expect(ttl).toBeGreaterThan(295_000);
		expect(ttl).toBeLessThanOrEqual(301_000);
		expect(up.audit).toMatchObject({ resourceType: 'required_file', resourceId: s.id, metadata: { file: 'upload', fileName: 'a.docx' } });
		expect(JSON.stringify(up.audit)).not.toMatch(/X-Amz/);
		expect((await run(w, { storeId: w.storeId, caseId: w.caseId, requiredFileId: s.id, file: 'example' })).body).toMatchObject({ fileName: 'e.pdf', contentType: 'application/pdf' });
	});

	it('links legacy disk files to the signed-in web download', async () => {
		const w = await world();
		const s = slot();
		m.slots.set(w.sfStore, [s]);
		const [doc] = await sql<{ id: string }[]>`INSERT INTO store_documents (store_id, original_name, storage_path, size_bytes, sfdc_case_file_id)
			VALUES (${w.storeId}, 'old.xls', 'old.xls', 1, ${s.id}) RETURNING id`;
		const r = await run(w, { storeId: w.storeId, requiredFileId: s.id });
		expect(r.body).toEqual({ url: `https://app.example.test/api/stores/${w.storeId}/documents/${doc.id}`, fileName: 'old.xls', contentType: 'application/vnd.ms-excel', expiresAt: null, requiresSignIn: true });
	});

	it('refuses foreign ids and connections without the permission', async () => {
		const w = await world();
		const other = await world();
		const s = slot({ upload: version('a.pdf', 'application/pdf') });
		m.slots.set(other.sfStore, [s]);
		expect((await run(w, { storeId: other.storeId, requiredFileId: s.id })).body.error.code).toBe('NOT_FOUND');
		expect((await run(w, { storeId: w.storeId, requiredFileId: s.id })).body.error.code).toBe('NOT_FOUND');
		const without = await world(['files.requirements.read']);
		expect((await run(without, { storeId: without.storeId, requiredFileId: s.id })).body.error.code).toBe('PERMISSION_DENIED');
	});
});

d('web example route', () => {
	const get = (userId: string | null, id: string) =>
		(webExample as unknown as (e: unknown) => Promise<unknown>)({ params: { s3DocId: id }, locals: { user: userId ? { id: userId } : null }, url: new URL('https://app.example.test/x?disposition=inline') });

	it("only looks among the slots of the user's own stores and their cases", async () => {
		const w = await world();
		const other = await world();
		const id = sfId('a0D');
		m.exampleRows = [];
		await expect(get(w.user.id, id)).rejects.toMatchObject({ status: 404 });
		expect(m.queries[0]).toContain(`Document_Template__r.Last_Version__c = '${id}'`);
		expect(m.queries[0]).toContain(`(Store__c IN ('${w.sfStore}') OR Case__r.Store__c IN ('${w.sfStore}'))`);
		expect(m.queries[0]).not.toContain(other.sfStore);

		m.exampleRows = [{ Document_Template__r: { Last_Version__r: { S3_Key__c: 'ex/k', File_Name__c: 'e.html', Content_Type__c: 'text/html' } } }];
		await expect(get(w.user.id, id)).rejects.toSatisfy((r: { status: number; location: string }) =>
			r.status === 302 && new URL(r.location).searchParams.get('response-content-disposition')!.startsWith('attachment'));
	});
	it('asks nothing of Salesforce for bad ids, anonymous users or users without stores', async () => {
		const w = await world();
		const loner = await makeUser({ accountId: (await makeAccount()).id });
		await expect(get(null, sfId('a0D'))).rejects.toMatchObject({ status: 401 });
		await expect(get(w.user.id, "x' OR Name != '")).rejects.toMatchObject({ status: 404 });
		await expect(get(loner.id, sfId('a0D'))).rejects.toMatchObject({ status: 404 });
		expect(m.queries).toHaveLength(0);
	});
});

d('the new permission', () => {
	it('can be stored, and re-running the migration changes no existing integration', async () => {
		const w = await world(['stores.list']);
		const { readFileSync } = await import('node:fs');
		await sql.unsafe(readFileSync(join(__dirname, '..', '..', 'db', 'migrations', '046_files_download_permission.sql'), 'utf8'));
		expect((await getIntegration(w.account.id, w.integration.id))!.permissions).toEqual(['stores.list']);
		await expect(sql`UPDATE integration_clients SET permissions = ${['files.download']} WHERE id = ${w.integration.id}`).resolves.toBeDefined();
		await expect(sql`UPDATE integration_clients SET permissions = ${['files.delete']} WHERE id = ${w.integration.id}`).rejects.toThrow(/permissions_allowed/);
	});
});
