/** Tenant isolation and failure handling of the case routes. Real database, stubbed Salesforce/S3. */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const m = vi.hoisted(() => ({
	lookup: vi.fn(), fetchCase: vi.fn(), listFiles: vi.fn(), listCases: vi.fn(), messages: vi.fn(), createMessage: vi.fn(),
	attach: vi.fn(), clear: vi.fn(), saveOnboarding: vi.fn(), updateRevenue: vi.fn(), put: vi.fn(), del: vi.fn(),
	ready: vi.fn(), notify: vi.fn(), todo: vi.fn()
}));

vi.mock('$lib/server/salesforce', () => ({
	findCaseStoreLookup: m.lookup,
	fetchCase: m.fetchCase,
	listRequiredFilesForCase: m.listFiles,
	listCasesForStores: m.listCases,
	getCaseSteps: async () => new Map(),
	listAppMessages: m.messages,
	createAppMessage: m.createMessage,
	markAppMessageRead: async () => ({ ok: true }),
	attachUploadToRequiredFile: m.attach,
	clearRequiredFile: m.clear,
	listCaseHistory: async () => ({ ok: true, history: [] }),
	buildCaseTimeline: () => [],
	fetchStoreMetrics: async () => ({ totalRevenueRecovered: null }),
	updateCaseEstimatedRevenueAtRisk: m.updateRevenue,
	fetchCaseOnboarding: async () => null,
	saveCaseOnboarding: m.saveOnboarding
}));
vi.mock('$lib/server/salesforce/case-auto-status', () => ({ getClientTodo: m.todo, isCaseReadyForTechnician: m.ready, notifyTechnician: m.notify }));
vi.mock('$lib/server/storage/s3', () => ({ putObject: m.put, deleteObject: m.del, getRegion: () => 'us-east-1' }));
vi.mock('$lib/server/error_log', () => ({ logError: async () => {}, describeError: () => ({ errorMessage: 'x', stack: '' }) }));

import { hasDb, makeAccount, makeUser, uniq } from '../setup/db';
import { sql } from '$lib/server/db';
import { load as canonicalLoad, actions as canonicalActions } from '../../src/routes/(app)/stores/[id]/issues/[caseId]/+page.server';
import { load as splitLoad, actions as splitActions } from '../../src/routes/(app)/issues/[caseId]/+page.server';
import { load as listLoad } from '../../src/routes/(app)/issues/+layout.server';

const CASE_A = '500Hn00000AaAaAIAV';
const CASE_B = '500Hn00000BbBbBIAV';
const SLOT_A = 'a0YHn00000AaAaAQAV';

describe.skipIf(!hasDb)('case routes: tenancy and failures', () => {
	let userA: { id: string; displayName: string };
	let userB: { id: string; displayName: string };
	let storeA = '', storeB = '', unlinkedA = '';
	let sfA = '', sfB = '';

	beforeAll(async () => {
		const mk = async () => {
			const account = await makeAccount();
			const u = await makeUser({ accountId: account.id });
			const sf = `a0S${uniq()}${uniq()}`.slice(0, 18);
			const [s] = await sql<{ id: string }[]>`INSERT INTO stores (account_id, name, sfdc_store_id) VALUES (${account.id}, ${'Store ' + uniq()}, ${sf}) RETURNING id`;
			return { user: { id: u.id, displayName: 'U' }, store: s.id, sf, account: account.id };
		};
		const a = await mk();
		const b = await mk();
		[userA, storeA, sfA] = [a.user, a.store, a.sf];
		[userB, storeB, sfB] = [b.user, b.store, b.sf];
		const [u] = await sql<{ id: string }[]>`INSERT INTO stores (account_id, name) VALUES (${a.account}, 'Unlinked') RETURNING id`;
		unlinkedA = u.id;
	});

	beforeEach(() => {
		Object.values(m).forEach((f) => f.mockReset());
		m.lookup.mockImplementation(async (id: string) => ({ ok: true, sfdcCaseId: id, sfdcStoreId: id === CASE_A ? sfA : sfB }));
		m.fetchCase.mockResolvedValue({ ok: true, record: { Id: CASE_A, CaseNumber: '001', Status: 'New' } });
		m.listFiles.mockResolvedValue({ ok: true, files: [{ id: SLOT_A, name: 'ID', uploaded: false, upload: null, example: null, createdAt: '' }] });
		m.messages.mockResolvedValue({ ok: true, messages: [] });
		m.listCases.mockResolvedValue({ ok: true, cases: [] });
		m.put.mockResolvedValue({ bucket: 'b' });
		m.attach.mockResolvedValue({ ok: true });
		m.ready.mockResolvedValue(false);
		m.todo.mockResolvedValue([]);
		m.notify.mockResolvedValue({ ok: true });
	});

	const depends = () => {};
	const canonical = (user: unknown, id: string, caseId: string) => (canonicalLoad as any)({ params: { id, caseId }, locals: { user }, depends });
	const split = (user: unknown, caseId: string) => (splitLoad as any)({ params: { caseId }, locals: { user }, depends });
	const form = (entries: Record<string, string | File>) => {
		const fd = new FormData();
		for (const [k, v] of Object.entries(entries)) fd.set(k, v);
		return { formData: async () => fd };
	};
	const act = (actions: any, name: string, user: unknown, params: Record<string, string>, entries: Record<string, string | File> = {}) =>
		actions[name]({ params, locals: { user }, request: form(entries) });
	const status = async (p: Promise<unknown>) => p.then(() => 200, (e) => e.status);
	const untouched = () => {
		for (const f of [m.attach, m.clear, m.saveOnboarding, m.updateRevenue, m.createMessage, m.put, m.del, m.notify]) expect(f).not.toHaveBeenCalled();
	};

	it('loads the same workspace through both routes for the owner', async () => {
		const full = await canonical(userA, storeA, CASE_A);
		const pane = await split(userA, CASE_A);
		expect(full).toMatchObject({ storeId: storeA, case: { CaseNumber: '001' } });
		expect(pane).toEqual({ caseId: CASE_A, loadError: null, workspace: full });
	});

	it('hides another account’s case on both routes without reading it', async () => {
		expect(await status(split(userB, CASE_A))).toBe(404);
		expect(await status(canonical(userB, storeB, CASE_A))).toBe(404);
		expect(await status(canonical(userB, storeA, CASE_A))).toBe(404);
		expect(m.fetchCase).not.toHaveBeenCalled();
		expect(m.messages).not.toHaveBeenCalled();
	});

	it('exposes no case through an unlinked or unknown store', async () => {
		expect(await status(canonical(userA, unlinkedA, CASE_B))).toBe(404);
		expect(await status(canonical(userA, '00000000-0000-0000-0000-000000000000', CASE_A))).toBe(404);
		m.lookup.mockResolvedValue({ ok: true, sfdcCaseId: CASE_A, sfdcStoreId: null });
		expect(await status(split(userA, CASE_A))).toBe(404);
		m.lookup.mockResolvedValue({ ok: true, sfdcCaseId: CASE_A, sfdcStoreId: 'a0Snotlocal000000A' });
		expect(await status(split(userA, CASE_A))).toBe(404);
		expect(m.fetchCase).not.toHaveBeenCalled();
	});

	it('rejects ids that are not Salesforce ids before querying', async () => {
		const bad = "x\\' OR Id != null --";
		expect(await status(split(userA, bad))).toBe(404);
		expect(await status(canonical(userA, storeA, bad))).toBe(404);
		expect(await status(act(splitActions, 'upload_doc', userA, { caseId: bad }))).toBe(404);
		expect(m.lookup).not.toHaveBeenCalled();
	});

	it('refuses every mutation of another account’s case', async () => {
		const names = ['save_onboarding', 'post_message', 'mark_read', 'recalculate_revenue_at_risk', 'upload_doc', 'clear_doc', 'notify_technician'];
		for (const name of names) {
			const entries = { body: 'hi', messageId: 'm1', requiredFileId: SLOT_A, file: new File(['x'], 'a.txt', { type: 'text/plain' }) };
			expect(await status(act(splitActions, name, userB, { caseId: CASE_A }, entries)), name).toBe(404);
			expect(await status(act(canonicalActions, name, userB, { id: storeB, caseId: CASE_A }, entries)), name).toBe(404);
		}
		untouched();
	});

	it('refuses a required-file slot that belongs to a different case', async () => {
		const entries = { requiredFileId: 'a0YHn00000ZzZzZQAV', s3DocumentId: 'victim', file: new File(['x'], 'a.txt', { type: 'text/plain' }) };
		for (const name of ['upload_doc', 'clear_doc']) {
			const r = await act(splitActions, name, userA, { caseId: CASE_A }, entries);
			expect(r.status).toBe(404);
		}
		untouched();
	});

	it('uploads for the owner and takes the tombstoned document id from Salesforce, not the browser', async () => {
		const up = await act(splitActions, 'upload_doc', userA, { caseId: CASE_A }, { requiredFileId: SLOT_A, file: new File(['x'], 'a.txt', { type: 'text/plain' }) });
		expect(up).toEqual({ uploadSuccess: 'Uploaded a.txt.', promptNotify: false });
		expect(m.put.mock.calls[0][0]).toContain(`/Stores/${storeA}/Issues/${CASE_A}/`);
		m.listFiles.mockResolvedValue({ ok: true, files: [{ id: SLOT_A, upload: { s3DocumentId: 'real-doc' } }] });
		await act(splitActions, 'clear_doc', userA, { caseId: CASE_A }, { requiredFileId: SLOT_A, s3DocumentId: 'forged' });
		expect(m.clear).toHaveBeenCalledWith(SLOT_A, 'real-doc', expect.anything());
	});

	it('asks to offer the notification when an upload leaves nothing outstanding', async () => {
		m.ready.mockResolvedValue(true);
		const up = await act(splitActions, 'upload_doc', userA, { caseId: CASE_A }, { requiredFileId: SLOT_A, file: new File(['x'], 'a.txt', { type: 'text/plain' }) });
		expect(up).toMatchObject({ promptNotify: true });
		expect(m.notify).not.toHaveBeenCalled();
	});

	it('notifies the technician for the owner on both routes, and passes a refusal on', async () => {
		for (const [actions, params] of [[splitActions, { caseId: CASE_A }], [canonicalActions, { id: storeA, caseId: CASE_A }]] as const) {
			expect(await act(actions, 'notify_technician', userA, params)).toMatchObject({ notifySuccess: expect.any(String) });
		}
		expect(m.notify).toHaveBeenCalledWith(CASE_A, expect.objectContaining({ userId: userA.id }));
		m.notify.mockResolvedValue({ ok: false, status: 409, error: 'This case is no longer waiting on you.' });
		expect(await act(splitActions, 'notify_technician', userA, { caseId: CASE_A })).toMatchObject({ status: 409, data: { notifyError: expect.stringContaining('no longer') } });
	});

	it('keeps a temporary Salesforce failure inside the pane', async () => {
		m.lookup.mockResolvedValue({ ok: false, error: 'timeout' });
		expect(await split(userA, CASE_A)).toMatchObject({ workspace: null, loadError: expect.stringContaining('Could not verify') });
		expect(await status(canonical(userA, storeA, CASE_A))).toBe(502);
		const r = await act(splitActions, 'upload_doc', userA, { caseId: CASE_A }, { requiredFileId: SLOT_A });
		expect(r).toMatchObject({ status: 502, data: { uploadError: expect.any(String) } });
		const msg = await act(canonicalActions, 'post_message', userA, { id: storeA, caseId: CASE_A }, { body: 'hello' });
		expect(msg.status).toBe(409);
		expect(m.fetchCase).not.toHaveBeenCalled();
		untouched();
	});

	it('reports a failed case read in the pane, and a deleted case as not found', async () => {
		m.fetchCase.mockResolvedValue({ ok: false, error: 'boom' });
		expect(await split(userA, CASE_A)).toMatchObject({ workspace: null, loadError: 'Could not load case: boom' });
		m.fetchCase.mockResolvedValue({ ok: false, error: 'gone', notFound: true });
		expect(await status(split(userA, CASE_A))).toBe(404);
	});

	describe('account-wide list', () => {
		const list = (user: unknown) => (listLoad as any)({ locals: { user }, depends: vi.fn() });

		it('queries only the account’s linked stores and joins each case to its store', async () => {
			m.listCases.mockResolvedValue({ ok: true, cases: [{ Id: CASE_A, Status: 'New', sfdcStoreId: sfA }, { Id: CASE_B, Status: 'Closed', sfdcStoreId: 'a0Sother' }] });
			const depended = vi.fn();
			const r = await (listLoad as any)({ locals: { user: userA }, depends: depended });
			expect(depended).toHaveBeenCalledWith('app:issues');
			expect(m.listCases.mock.calls[0][0]).toEqual([sfA]);
			expect(r.storesTotal).toBe(2);
			expect(r.issues.map((i: any) => i.localStoreId)).toEqual([storeA, null]);
		});
		it('returns the Salesforce error instead of throwing', async () => {
			m.listCases.mockResolvedValue({ ok: false, error: 'SF down' });
			expect(await list(userA)).toMatchObject({ issues: [], storesError: 'SF down' });
		});
		it('returns a generic error instead of throwing on an unexpected failure', async () => {
			m.listCases.mockRejectedValue(new Error('kaboom'));
			expect(await list(userA)).toMatchObject({ issues: [], storesError: expect.stringContaining('went wrong') });
		});
	});
});
