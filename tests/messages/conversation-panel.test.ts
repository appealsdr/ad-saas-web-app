import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import ConversationPanel from '../../src/lib/components/messages/ConversationPanel.svelte';
import {
	filterMessages,
	firstUnreadId,
	dayLabel,
	initials,
	isInternalSender,
	plainPreview,
	sortMessages
} from '../../src/lib/components/messages/conversation-utils';
import type { AppMessage, ConversationData } from '../../src/lib/types/app-message';

const msg = (over: Partial<AppMessage> = {}): AppMessage => ({
	Id: 'm1',
	body: '<p>Hello team</p>',
	senderType: 'internal',
	senderContactId: null,
	senderContactName: null,
	createdByName: 'Dana Staff',
	createdById: 'u1',
	displayName: 'Dana Staff',
	createdAt: '2026-11-20T10:00:00.000Z',
	replyToMessageId: null,
	messageRead: null,
	...over
});
const conv = (over: Partial<ConversationData> = {}): ConversationData => ({
	kind: 'account',
	contextType: 'Account',
	contextId: '001000000000001AAA',
	available: true,
	unavailableReason: null,
	canSend: true,
	sendDisabledReason: null,
	messages: [],
	error: null,
	currentContactId: '003000000000001AAA',
	...over
});
const html = (props: Record<string, unknown>) => render(ConversationPanel, { props }).body;

describe('ConversationPanel rendering', () => {
	it('loading state', () => {
		const out = html({ loading: true, title: 'Account messages' });
		expect(out).toContain('Loading messages');
		expect(out).toContain('aria-busy="true"');
		expect(out).not.toContain('Write a message');
	});
	it('unavailable state shows the reason and no composer', () => {
		const out = html({
			conversation: conv({ available: false, contextId: null, unavailableReason: 'This store is not linked to Salesforce yet.' })
		});
		expect(out).toContain('Messages unavailable');
		expect(out).toContain('This store is not linked to Salesforce yet.');
		expect(out).not.toContain('Send');
	});
	it('empty state invites the first message', () => {
		const out = html({ conversation: conv() });
		expect(out).toContain('No messages yet');
		expect(out).toContain('Search messages');
		expect(out).toContain('Refresh messages');
	});
	it('error state is announced and offers retry', () => {
		const out = html({ conversation: conv({ error: 'Could not load messages. Please try again.' }) });
		expect(out).toContain('role="alert"');
		expect(out).toContain('Could not load messages. Please try again.');
		expect(out).toContain('Retry');
	});
	it('populated: renders sanitized bodies, author, badges and the scope header', () => {
		const out = html({
			conversation: conv({ messages: [msg(), msg({ Id: 'm2', senderType: 'external', displayName: 'Pat Seller', body: '<b>Thanks</b>' })] }),
			title: 'Store messages',
			scopeBadge: 'This store only',
			scopeSubtitle: 'Main Store'
		});
		expect(out).toContain('Store messages');
		expect(out).toContain('This store only');
		expect(out).toContain('Main Store');
		expect(out).toContain('Dana Staff');
		expect(out).toContain('<p>Hello team</p>');
		expect(out).toContain('Team');
		expect(out).toContain('Client');
		expect(out).toContain('data-context-type="Account"');
	});
	it('unread: highlights messages from others, shows the new-messages divider, never flags own messages', () => {
		const out = html({
			conversation: conv({
				messages: [
					msg({ Id: 'a', messageRead: '2026-11-20T10:05:00Z' }),
					msg({ Id: 'b', createdAt: '2026-11-20T11:00:00Z' }),
					msg({ Id: 'c', createdAt: '2026-11-20T12:00:00Z', senderContactId: '003000000000001AAA', displayName: 'Me' })
				]
			})
		});
		expect(out).toContain('1 new message');
		expect(out).toContain('(unread)');
		expect(out.match(/\(unread\)/g)).toHaveLength(1);
		expect(out).toContain('Me (You)');
	});
	it('reply state: shows the quoted parent', () => {
		const out = html({
			conversation: conv({
				messages: [
					msg({ Id: 'p', body: '<p>Original question</p>', displayName: 'Dana Staff' }),
					msg({ Id: 'r', replyToMessageId: 'p', createdAt: '2026-11-20T11:00:00Z', displayName: 'Pat', senderType: 'external' })
				]
			})
		});
		expect(out).toContain('Original question');
		expect(out).toContain('conv-quote');
	});
	it('without a linked Contact the composer is replaced by an actionable notice and replies are disabled', () => {
		const out = html({
			conversation: conv({ canSend: false, sendDisabledReason: 'Your Salesforce Contact is not linked yet.', messages: [msg()] })
		});
		expect(out).toContain('Your Salesforce Contact is not linked yet.');
		expect(out).not.toContain('name="body"');
		expect(out).toMatch(/conv-reply-btn[^>]*disabled/);
	});
	it('channel variant (Messages tab) renders the Slack-style channel with a custom composer placeholder', () => {
		const out = html({
			conversation: conv({ messages: [msg()] }),
			variant: 'channel',
			title: '# Account chat',
			composerPlaceholder: 'Message Account chat'
		});
		expect(out).toContain('# Account chat');
		expect(out).toMatch(/class="conv[^"]*channel/);
		expect(out).toContain('height:100%');
	});
	it('wires form actions and a hidden reply field for the composer', () => {
		const out = html({ conversation: conv(), postAction: '?/post_message' });
		expect(out).toContain('action="?/post_message"');
		expect(out).toContain('name="replyToMessageId"');
	});
});

describe('conversation-utils', () => {
	it('sorts chronologically (oldest first)', () => {
		const sorted = sortMessages([msg({ Id: 'b', createdAt: '2026-11-21T00:00:00Z' }), msg({ Id: 'a', createdAt: '2026-11-20T00:00:00Z' })]);
		expect(sorted.map((m) => m.Id)).toEqual(['a', 'b']);
	});
	it('filters by author and body text', () => {
		const list = [msg({ Id: 'a', displayName: 'Dana', body: '<p>invoice</p>' }), msg({ Id: 'b', displayName: 'Pat', body: '<p>refund</p>' })];
		expect(filterMessages(list, 'REFUND').map((m) => m.Id)).toEqual(['b']);
		expect(filterMessages(list, 'dana').map((m) => m.Id)).toEqual(['a']);
		expect(filterMessages(list, '  ')).toHaveLength(2);
	});
	it('finds the first unread message from someone else', () => {
		const list = [msg({ Id: 'a', messageRead: 'x' }), msg({ Id: 'b', senderContactId: 'me' }), msg({ Id: 'c' })];
		expect(firstUnreadId(list, 'me')).toBe('c');
		expect(firstUnreadId([msg({ messageRead: 'x' })], null)).toBeNull();
	});
	it('helpers: initials, sender type, previews, day labels', () => {
		expect(initials('Pat Q Seller')).toBe('PS');
		expect(initials(null)).toBe('??');
		expect(isInternalSender('Internal')).toBe(true);
		expect(isInternalSender('external')).toBe(false);
		expect(plainPreview('<p>' + 'a'.repeat(100) + '</p>', 10)).toHaveLength(10);
		const now = new Date('2026-11-21T12:00:00');
		expect(dayLabel('2026-11-21T01:00:00', now)).toBe('Today');
		expect(dayLabel('2026-11-20T23:00:00', now)).toBe('Yesterday');
		expect(dayLabel('2026-11-01T10:00:00', now)).toMatch(/Nov 1, 2026/);
	});
});
