import { describe, it, expect, vi, beforeEach } from 'vitest';

const { conv, overviewMod } = vi.hoisted(() => ({
	conv: {
		resolveAccountScope: vi.fn(),
		resolveStoreScope: vi.fn(),
		resolveCaseScope: vi.fn(),
		loadConversationSafe: vi.fn(),
		postConversationMessage: vi.fn(),
		markConversationRead: vi.fn()
	},
	overviewMod: { loadMessagesOverview: vi.fn() }
}));
vi.mock('$lib/server/db', () => ({ sql: vi.fn(async () => [{ sfdc_contact_id: '003000000000001AAA' }]) }));
vi.mock('$lib/server/error_log', () => ({ logError: vi.fn(async () => {}) }));
vi.mock('$lib/server/messages/conversation', () => conv);
vi.mock('$lib/server/messages/overview', () => overviewMod);

import { load, actions } from '../../src/routes/(app)/messages/+page.server';

const USER = { id: 'u1' };
const scope = { kind: 'account', contextType: 'Account', contextId: '001000000000001AAA', accountId: 'acct-1', unavailableReason: null, label: 'Acme' };
const form = (o: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(o)) f.set(k, v);
	return f;
};
const ev = (over: object = {}) => ({ locals: { user: USER }, url: new URL('http://x/messages?/post_message'), request: { formData: async () => form({ body: 'hi' }) }, ...over }) as never;

beforeEach(() => {
	Object.values(conv).forEach((f) => f.mockReset());
	overviewMod.loadMessagesOverview.mockReset();
});

describe('/messages load', () => {
	it('redirects anonymous users to login', async () => {
		await expect((load as any)({ locals: { user: null } })).rejects.toMatchObject({ status: 303, location: '/login' });
	});
	it('resolves the account from the session only and streams conversation + overview', async () => {
		conv.resolveAccountScope.mockResolvedValue(scope);
		conv.loadConversationSafe.mockResolvedValue({ messages: [] });
		overviewMod.loadMessagesOverview.mockResolvedValue({ stores: [], totalUnread: 0 });
		const res: any = await (load as any)({ locals: { user: USER }, url: new URL('http://x/messages?accountId=evil'), parent: async () => ({ messagesEnabled: true }) });
		expect(conv.resolveAccountScope).toHaveBeenCalledWith(USER);
		expect(res.account).toEqual({ name: 'Acme' });
		await expect(res.conversation).resolves.toEqual({ messages: [] });
		await expect(res.overview).resolves.toEqual({ stores: [], totalUnread: 0 });
		expect(overviewMod.loadMessagesOverview).toHaveBeenCalledWith(USER, 'acct-1', '001000000000001AAA', '003000000000001AAA', null);
	});
	it('returns an empty state when the user has no account', async () => {
		conv.resolveAccountScope.mockResolvedValue(null);
		const res: any = await (load as any)({ locals: { user: USER }, url: new URL('http://x/messages'), parent: async () => ({ messagesEnabled: true }) });
		expect(res.account).toBeNull();
	});
	it('an overview failure degrades to null instead of breaking the page', async () => {
		conv.resolveAccountScope.mockResolvedValue(scope);
		conv.loadConversationSafe.mockResolvedValue({ messages: [] });
		overviewMod.loadMessagesOverview.mockRejectedValue(new Error('sf down'));
		const res: any = await (load as any)({ locals: { user: USER }, url: new URL('http://x/messages'), parent: async () => ({ messagesEnabled: true }) });
		await expect(res.overview).resolves.toBeNull();
	});
});

describe('/messages is opt-in per account (AD-1968)', () => {
	it('redirects to the dashboard when an admin has not enabled Messages for the account', async () => {
		await expect((load as any)({ locals: { user: USER }, url: new URL('http://x/messages'), parent: async () => ({ messagesEnabled: false }) }))
			.rejects.toMatchObject({ status: 303, location: '/dashboard' });
		expect(conv.resolveAccountScope).not.toHaveBeenCalled();
	});
});

describe('/messages conversation selection (account / store / case)', () => {
	const storeScope = { ...scope, kind: 'store', contextType: 'Store__c', contextId: 'a01000000000001AAA' };
	const caseScope = { ...scope, kind: 'case', contextType: 'Case', contextId: '500000000000001AAA' };
	const run = (qs: string) => (load as any)({ locals: { user: USER }, url: new URL(`http://x/messages${qs}`), parent: async () => ({ messagesEnabled: true }) });
	beforeEach(() => {
		conv.resolveAccountScope.mockResolvedValue(scope);
		conv.loadConversationSafe.mockResolvedValue({ messages: [] });
		overviewMod.loadMessagesOverview.mockResolvedValue({ stores: [] });
	});

	it('no selection → the ACCOUNT conversation only', async () => {
		const res: any = await run('');
		expect(res.selected).toMatchObject({ kind: 'account', storeId: null, caseId: null, actionQuery: '' });
		expect(conv.loadConversationSafe.mock.calls[0][0]).toBe(scope);
		expect(conv.resolveStoreScope).not.toHaveBeenCalled();
	});
	it('?store= → the STORE conversation, tenant-checked through resolveStoreScope', async () => {
		conv.resolveStoreScope.mockResolvedValue(storeScope);
		const res: any = await run('?store=st1');
		expect(conv.resolveStoreScope).toHaveBeenCalledWith(USER, 'st1');
		expect(conv.loadConversationSafe.mock.calls[0][0]).toBe(storeScope);
		expect(res.selected).toMatchObject({ kind: 'store', storeId: 'st1', caseId: null, actionQuery: '&store=st1' });
	});
	it('?store=&case= → the CASE conversation, tenant-checked through resolveCaseScope', async () => {
		conv.resolveCaseScope.mockResolvedValue(caseScope);
		const res: any = await run('?store=st1&case=500000000000001AAA');
		expect(conv.resolveCaseScope).toHaveBeenCalledWith(USER, 'st1', '500000000000001AAA');
		expect(conv.loadConversationSafe.mock.calls[0][0]).toBe(caseScope);
		expect(res.selected).toMatchObject({ kind: 'case', actionQuery: '&store=st1&case=500000000000001AAA' });
		await res.overview;
		expect(overviewMod.loadMessagesOverview.mock.calls[0][4]).toBe('500000000000001AAA');
	});
	it('a store/case the user does not own is a 404 — nothing is loaded', async () => {
		conv.resolveStoreScope.mockResolvedValue(null);
		await expect(run('?store=someone-elses')).rejects.toMatchObject({ status: 404 });
		conv.resolveCaseScope.mockResolvedValue(null);
		await expect(run('?store=st1&case=500000000000009AAA')).rejects.toMatchObject({ status: 404 });
		await expect(run('?case=500000000000001AAA')).rejects.toMatchObject({ status: 404 }); // case without store
		expect(conv.loadConversationSafe).not.toHaveBeenCalled();
	});
	it('post_message / mark_read act on the selected store or case conversation', async () => {
		conv.resolveStoreScope.mockResolvedValue(storeScope);
		conv.resolveCaseScope.mockResolvedValue(caseScope);
		conv.postConversationMessage.mockResolvedValue({ ok: true });
		conv.markConversationRead.mockResolvedValue({ ok: true });
		await (actions.post_message as any)(ev({ url: new URL('http://x/messages?/post_message&store=st1') }));
		expect(conv.postConversationMessage.mock.calls[0][0]).toBe(storeScope);
		await (actions.mark_read as any)(
			ev({ url: new URL('http://x/messages?/mark_read&store=st1&case=500000000000001AAA'), request: { formData: async () => form({ messageId: 'a02000000000001AAA' }) } })
		);
		expect(conv.markConversationRead.mock.calls[0][0]).toBe(caseScope);
	});
	it('actions refuse a conversation the user does not own', async () => {
		conv.resolveStoreScope.mockResolvedValue(null);
		const res: any = await (actions.post_message as any)(ev({ url: new URL('http://x/messages?/post_message&store=evil') }));
		expect(res.status).toBe(404);
		expect(conv.postConversationMessage).not.toHaveBeenCalled();
	});
});

describe('/messages actions', () => {
	it('post_message sends to the session-resolved account scope', async () => {
		conv.resolveAccountScope.mockResolvedValue(scope);
		conv.postConversationMessage.mockResolvedValue({ ok: true });
		const res: any = await (actions.post_message as any)(ev());
		expect(res).toEqual({ messageSuccess: 'Message sent.' });
		expect(conv.postConversationMessage.mock.calls[0][0]).toBe(scope);
	});
	it('post_message surfaces validation failures with the submitted body', async () => {
		conv.resolveAccountScope.mockResolvedValue(scope);
		conv.postConversationMessage.mockResolvedValue({ ok: false, status: 400, error: 'Message cannot be empty.', body: '' });
		const res: any = await (actions.post_message as any)(ev());
		expect(res.status).toBe(400);
		expect(res.data).toMatchObject({ messageError: 'Message cannot be empty.' });
	});
	it('mark_read is scoped to the account conversation', async () => {
		conv.resolveAccountScope.mockResolvedValue(scope);
		conv.markConversationRead.mockResolvedValue({ ok: true });
		const res: any = await (actions.mark_read as any)(ev({ request: { formData: async () => form({ messageId: 'a02000000000001AAA' }) } }));
		expect(res).toEqual({ readSuccess: true });
		expect(conv.markConversationRead).toHaveBeenCalledWith(scope, USER, 'a02000000000001AAA');
	});
	it('both actions require login', async () => {
		await expect((actions.post_message as any)({ locals: { user: null } })).rejects.toMatchObject({ status: 303 });
		await expect((actions.mark_read as any)({ locals: { user: null } })).rejects.toMatchObject({ status: 303 });
	});
});
