import { describe, it, expect, vi, beforeEach } from 'vitest';

const { conv, overviewMod } = vi.hoisted(() => ({
	conv: {
		resolveAccountScope: vi.fn(),
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
const ev = (over: object = {}) => ({ locals: { user: USER }, request: { formData: async () => form({ body: 'hi' }) }, ...over }) as never;

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
		const res: any = await (load as any)({ locals: { user: USER }, url: new URL('http://x/messages?accountId=evil') });
		expect(conv.resolveAccountScope).toHaveBeenCalledWith(USER);
		expect(res.account).toEqual({ name: 'Acme' });
		await expect(res.conversation).resolves.toEqual({ messages: [] });
		await expect(res.overview).resolves.toEqual({ stores: [], totalUnread: 0 });
		expect(overviewMod.loadMessagesOverview).toHaveBeenCalledWith(USER, 'acct-1', '001000000000001AAA', '003000000000001AAA');
	});
	it('returns an empty state when the user has no account', async () => {
		conv.resolveAccountScope.mockResolvedValue(null);
		const res: any = await (load as any)({ locals: { user: USER } });
		expect(res.account).toBeNull();
	});
	it('an overview failure degrades to null instead of breaking the page', async () => {
		conv.resolveAccountScope.mockResolvedValue(scope);
		conv.loadConversationSafe.mockResolvedValue({ messages: [] });
		overviewMod.loadMessagesOverview.mockRejectedValue(new Error('sf down'));
		const res: any = await (load as any)({ locals: { user: USER } });
		await expect(res.overview).resolves.toBeNull();
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
