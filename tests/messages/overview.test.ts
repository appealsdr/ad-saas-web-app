import { describe, it, expect } from 'vitest';
import { buildMessagesOverview } from '../../src/lib/server/messages/overview';
import type { AppMessageWithContext } from '../../src/lib/types/app-message';

const ME = '003000000000001AAA';
const S1 = 'a01000000000001AAA';
const S2 = 'a01000000000002AAA';
const C1 = '500000000000001AAA';
const C2 = '500000000000002AAA';

const m = (over: Partial<AppMessageWithContext>): AppMessageWithContext => ({
	Id: Math.random().toString(36).slice(2),
	body: '<p>Hello</p>',
	senderType: 'internal',
	senderContactId: 'other',
	senderContactName: null,
	createdByName: 'Dana',
	createdById: 'u',
	displayName: 'Dana',
	createdAt: '2026-11-20T10:00:00Z',
	replyToMessageId: null,
	messageRead: null,
	contextType: 'Store__c',
	contextId: S1,
	caseNumber: null,
	...over
});
const stores = [
	{ id: 'st1', name: 'Store A', sfdc_store_id: S1 },
	{ id: 'st2', name: 'Store B', sfdc_store_id: S2 },
	{ id: 'st3', name: 'Store C', sfdc_store_id: null }
];
const cases = [
	{ Id: C1, CaseNumber: '1042', Subject: 'Suspension', recordTypeName: null, sfdcStoreId: S1 },
	{ Id: C2, CaseNumber: '1051', Subject: null, recordTypeName: 'Invoice', sfdcStoreId: S2 }
];

describe('buildMessagesOverview', () => {
	const base = { stores, cases, currentContactId: ME };

	it('counts unread per account, store and case, excluding read and own messages', () => {
		const o = buildMessagesOverview({
			...base,
			accountMessages: [m({ contextType: 'Account', contextId: 'acc' }), m({ contextType: 'Account', contextId: 'acc', messageRead: 'x' }), m({ contextType: 'Account', contextId: 'acc', senderContactId: ME })],
			storeMessages: [m({}), m({}), m({ contextId: S2 })],
			caseMessages: [m({ contextType: 'Case', contextId: C1, caseNumber: '1042' }), m({ contextType: 'Case', contextId: C1, caseNumber: '1042', messageRead: 'x' })]
		});
		expect(o.accountUnread).toBe(1);
		const a = o.stores.find((s) => s.id === 'st1')!;
		expect(a).toMatchObject({ storeUnread: 2, caseUnread: 1, totalUnread: 3, caseCount: 1 });
		expect(o.stores.find((s) => s.id === 'st2')).toMatchObject({ storeUnread: 1, caseUnread: 0 });
		expect(o.totalUnread).toBe(1 + 3 + 1);
		expect(o.partial).toBe(false);
	});

	it('sorts stores with unread first, then by name; unlinked stores are flagged', () => {
		const o = buildMessagesOverview({ ...base, accountMessages: [], storeMessages: [m({ contextId: S2 })], caseMessages: [] });
		expect(o.stores.map((s) => s.name)).toEqual(['Store B', 'Store A', 'Store C']);
		expect(o.stores.find((s) => s.id === 'st3')).toMatchObject({ linked: false, totalUnread: 0, caseCount: 0 });
	});

	it('lists cases with unread first and builds tenant-scoped links', () => {
		const o = buildMessagesOverview({
			...base,
			cases: [...cases, { Id: '500000000000003AAA', CaseNumber: '1043', Subject: 'Other', recordTypeName: null, sfdcStoreId: S1 }],
			accountMessages: [],
			storeMessages: [],
			caseMessages: [m({ contextType: 'Case', contextId: '500000000000003AAA' })]
		});
		const a = o.stores.find((s) => s.id === 'st1')!;
		expect(a.cases.map((c) => c.number)).toEqual(['1043', '1042']);
		expect(a.cases[0]).toMatchObject({ unread: 1, href: '/stores/st1/issues/500000000000003AAA', label: 'Case #1043 · Other' });
		expect(a.href).toBe('/stores/st1#store-messages');
	});

	it('picks the latest message across the store chat and its cases as the preview', () => {
		const o = buildMessagesOverview({
			...base,
			accountMessages: [],
			storeMessages: [m({ body: '<p>old store msg</p>', createdAt: '2026-11-19T10:00:00Z' })],
			caseMessages: [m({ contextType: 'Case', contextId: C1, caseNumber: '1042', body: '<b>Newer case msg</b>', createdAt: '2026-11-20T12:00:00Z', displayName: 'Pat' })]
		});
		expect(o.stores.find((s) => s.id === 'st1')!.lastMessage).toMatchObject({
			author: 'Pat',
			preview: 'Newer case msg',
			source: 'case',
			caseNumber: '1042'
		});
		expect(o.stores.find((s) => s.id === 'st2')!.lastMessage).toBeNull();
	});

	it('marks the overview partial when a context failed to load but still reports the rest', () => {
		const o = buildMessagesOverview({ ...base, accountMessages: [m({ contextType: 'Account', contextId: 'a' })], storeMessages: undefined, caseMessages: [] });
		expect(o.partial).toBe(true);
		expect(o.accountUnread).toBe(1);
		expect(o.stores.every((s) => s.storeUnread === 0)).toBe(true);
	});

	it('ignores cases without a store and messages for unknown cases', () => {
		const o = buildMessagesOverview({
			...base,
			cases: [{ Id: C1, CaseNumber: '1', Subject: null, recordTypeName: null, sfdcStoreId: null }],
			accountMessages: [],
			storeMessages: [],
			caseMessages: [m({ contextType: 'Case', contextId: C1 })]
		});
		expect(o.stores.every((s) => s.caseCount === 0 && s.totalUnread === 0)).toBe(true);
	});
});
