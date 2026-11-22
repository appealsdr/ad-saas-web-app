import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sqlQueue, sqlMock, sf } = vi.hoisted(() => {
	const sqlQueue: unknown[][] = [];
	return {
		sqlQueue,
		sqlMock: vi.fn(async () => sqlQueue.shift() ?? []),
		sf: {
			listCasesForStores: vi.fn(),
			listRequiredFilesForStores: vi.fn(),
			listRequiredFilesForCases: vi.fn(),
			listRecentAppMessagesForContexts: vi.fn()
		}
	};
});
vi.mock('$lib/server/db', () => ({ sql: (...a: unknown[]) => (sqlMock as any)(...a) }));
vi.mock('$lib/server/salesforce', () => sf);

import { aggregateMessageNotifications } from '../../src/lib/server/messages/notifications';
import { GET } from '../../src/routes/api/notifications/+server';
import type { AppMessageWithContext } from '../../src/lib/types/app-message';

const ME = '003000000000001AAA';
const SF_STORE = 'a01000000000001AAA';
const SF_CASE = '500000000000001AAA';
const SF_ACCOUNT = '001000000000001AAA';

const m = (over: Partial<AppMessageWithContext>): AppMessageWithContext => ({
	Id: 'm',
	body: 'x',
	senderType: 'internal',
	senderContactId: 'someone-else',
	senderContactName: null,
	createdByName: 'Dana',
	createdById: 'u',
	displayName: 'Dana',
	createdAt: '2026-11-20T10:00:00Z',
	replyToMessageId: null,
	messageRead: null,
	contextType: 'Case',
	contextId: SF_CASE,
	caseNumber: '00001042',
	...over
});
const store = { id: 'local-store', name: 'Main Store' };
const maps = {
	storeBySfdcId: new Map([[SF_STORE, store]]),
	caseStoreById: new Map([[SF_CASE, store]])
};

describe('aggregateMessageNotifications', () => {
	it('builds context-specific subtitles and tenant-scoped destinations', () => {
		const items = aggregateMessageNotifications({
			currentContactId: ME,
			...maps,
			case: [m({ Id: 'c1' })],
			store: [m({ Id: 's1', contextType: 'Store__c', contextId: SF_STORE, caseNumber: null })],
			account: [m({ Id: 'a1', contextType: 'Account', contextId: SF_ACCOUNT, caseNumber: null })]
		});
		const by = Object.fromEntries(items.map((i) => [i.id, i]));
		expect(by.c1).toMatchObject({ subtitle: 'Case 00001042 · Main Store', href: '/stores/local-store/issues/' + SF_CASE });
		expect(by.s1).toMatchObject({ subtitle: 'Store: Main Store', href: '/stores/local-store#store-messages' });
		expect(by.a1).toMatchObject({ subtitle: 'Account messages', href: '/accounts#account-messages' });
		expect(by.c1.title).toBe('New message from Dana');
	});
	it('excludes read messages and the signed-in user’s own messages', () => {
		const items = aggregateMessageNotifications({
			currentContactId: ME,
			...maps,
			case: [
				m({ Id: 'read', messageRead: '2026-11-20T11:00:00Z' }),
				m({ Id: 'mine', senderContactId: ME }),
				m({ Id: 'keep' })
			]
		});
		expect(items.map((i) => i.id)).toEqual(['keep']);
	});
	it('deduplicates records and sorts newest-first across contexts', () => {
		const items = aggregateMessageNotifications({
			currentContactId: null,
			...maps,
			case: [m({ Id: 'dup', createdAt: '2026-11-20T10:00:00Z' }), m({ Id: 'old', createdAt: '2026-11-18T10:00:00Z' })],
			store: [m({ Id: 'dup', contextType: 'Store__c', contextId: SF_STORE }), m({ Id: 'new', contextType: 'Store__c', contextId: SF_STORE, createdAt: '2026-11-21T10:00:00Z' })]
		});
		expect(items.map((i) => i.id)).toEqual(['new', 'dup', 'old']);
	});
	it('falls back to generic destinations for records it cannot map to a tenant store', () => {
		const items = aggregateMessageNotifications({
			currentContactId: ME,
			storeBySfdcId: new Map(),
			caseStoreById: new Map(),
			case: [m({ Id: 'c' })],
			store: [m({ Id: 's', contextType: 'Store__c', contextId: SF_STORE })]
		});
		expect(items.find((i) => i.id === 'c')?.href).toBe('/issues');
		expect(items.find((i) => i.id === 's')?.href).toBe('/stores');
	});
	it('skips a context that failed to load (undefined) but keeps the others', () => {
		const items = aggregateMessageNotifications({
			currentContactId: ME,
			...maps,
			case: undefined,
			account: [m({ Id: 'a1', contextType: 'Account', contextId: SF_ACCOUNT })]
		});
		expect(items.map((i) => i.id)).toEqual(['a1']);
	});
});

describe('GET /api/notifications', () => {
	const run = async (user: object | null = { id: 'u1' }) => ((await GET({ locals: { user } } as never)) as Response).json();
	beforeEach(() => {
		sqlQueue.length = 0;
		Object.values(sf).forEach((f) => f.mockReset());
		sf.listRequiredFilesForStores.mockResolvedValue({ ok: true, files: [] });
		sf.listRequiredFilesForCases.mockResolvedValue({ ok: true, files: [] });
		sf.listCasesForStores.mockResolvedValue({
			ok: true,
			cases: [{ Id: SF_CASE, CaseNumber: '00001042', sfdcStoreId: SF_STORE }]
		});
	});
	const queueUser = () =>
		sqlQueue.push(
			[{ account_id: 'acct-1', sfdc_contact_id: ME, sfdc_account_id: SF_ACCOUNT }],
			[{ id: 'local-store', name: 'Main Store', sfdc_store_id: SF_STORE }]
		);

	it('anonymous users get nothing', async () => {
		expect(await run(null)).toEqual({ items: [], total: 0 });
	});

	it('queries unread messages for all three contexts using only the tenant’s own ids', async () => {
		queueUser();
		sf.listRecentAppMessagesForContexts.mockResolvedValue({ ok: true, messages: [] });
		await run();
		const calls = sf.listRecentAppMessagesForContexts.mock.calls.map((c) => [c[0], c[1], c[4]]);
		expect(calls).toEqual([
			['Case', [SF_CASE], { unreadOnly: true }],
			['Store__c', [SF_STORE], { unreadOnly: true }],
			['Account', [SF_ACCOUNT], { unreadOnly: true }]
		]);
	});

	it('merges all contexts newest-first, caps items at 4 and reports the full total', async () => {
		queueUser();
		const at = (h: number) => `2026-11-20T${String(h).padStart(2, '0')}:00:00Z`;
		sf.listRecentAppMessagesForContexts.mockImplementation(async (type: string) => ({
			ok: true,
			messages:
				type === 'Case'
					? [m({ Id: 'c1', createdAt: at(1) }), m({ Id: 'c2', createdAt: at(5) })]
					: type === 'Store__c'
						? [m({ Id: 's1', contextType: 'Store__c', contextId: SF_STORE, createdAt: at(4) }), m({ Id: 's2', contextType: 'Store__c', contextId: SF_STORE, createdAt: at(2) })]
						: [m({ Id: 'a1', contextType: 'Account', contextId: SF_ACCOUNT, createdAt: at(6) }), m({ Id: 'own', contextType: 'Account', contextId: SF_ACCOUNT, senderContactId: ME, createdAt: at(9) })]
		}));
		const res = await run();
		expect(res.items.map((i: { id: string }) => i.id)).toEqual(['a1', 'c2', 's1', 's2']);
		expect(res.total).toBe(5);
		expect(res.items[0]).not.toHaveProperty('createdAt');
	});

	it('still returns notifications from the other contexts when one fails', async () => {
		queueUser();
		sf.listRecentAppMessagesForContexts.mockImplementation(async (type: string) => {
			if (type === 'Store__c') throw new Error('boom');
			if (type === 'Case') return { ok: false, error: 'down' };
			return { ok: true, messages: [m({ Id: 'a1', contextType: 'Account', contextId: SF_ACCOUNT })] };
		});
		const res = await run();
		expect(res.items.map((i: { id: string }) => i.id)).toEqual(['a1']);
		expect(res.total).toBe(1);
	});
});
