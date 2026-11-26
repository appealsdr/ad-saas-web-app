/** Server-rendered checks of the case list views and the shared workspace. */
import { describe, it, expect } from 'vitest';
import { render } from 'svelte/server';
import CaseTable from '../../src/lib/components/cases/CaseTable.svelte';
import CaseCompactList from '../../src/lib/components/cases/CaseCompactList.svelte';
import CaseListToolbar from '../../src/lib/components/cases/CaseListToolbar.svelte';
import CaseListStatus from '../../src/lib/components/cases/CaseListStatus.svelte';
import CaseWorkspace from '../../src/lib/components/cases/CaseWorkspace.svelte';

const row = (over: Record<string, unknown> = {}) => ({
	Id: '500A', CaseNumber: '00012', Subject: 'Listing removed', Status: 'In Progress', Priority: 'High',
	CreatedDate: '2026-01-02T00:00:00Z', LastModifiedDate: '2026-01-03T00:00:00Z', recordTypeName: 'Appeal',
	sfdcStoreId: 'sf', localStoreId: 'store-1', storeName: 'Acme', ...over
});
const rows = [row(), row({ Id: '500B', CaseNumber: '00013', Subject: null, recordTypeName: null, localStoreId: null, storeName: null })];
const html = (c: unknown, props: Record<string, unknown>) => render(c as never, { props } as never).body;

describe('CaseTable', () => {
	const out = html(CaseTable, { cases: rows });
	it('keeps the eight columns in order', () => {
		const headers = [...out.matchAll(/<th(?![a-z])[^>]*>(.*?)<\/th>/g)].map((x) => x[1]);
		expect(headers).toEqual(['Case #', 'Subject', 'Store', 'Service', 'Status', 'Priority', 'Opened', 'Last modified']);
	});
	it('links only linked cases to the canonical URL', () => {
		expect(out).toContain('href="/stores/store-1/issues/500A"');
		expect(out).not.toContain('/issues/500B');
		expect(out).toContain('Unlinked store');
	});
});

describe('CaseCompactList', () => {
	const out = html(CaseCompactList, { cases: rows, selectedId: '500A', hrefFor: (id: string) => `/issues/${id}?view=split` });
	it('shows case number, subject, store, service and status only', () => {
		for (const v of ['00012', 'Listing removed', 'Acme', 'Appeal', 'In Progress']) expect(out).toContain(v);
		for (const v of ['High', '2026']) expect(out).not.toContain(v);
	});
	it('shows each status as a badge, for unlinked cases too', () => {
		expect(out.match(/badge badge-orange[^>]*>(<!--[^>]*-->)*In Progress/g)).toHaveLength(2);
	});
	it('marks the selection and gives unlinked cases no link', () => {
		expect(out.match(/aria-current="true"/g)).toHaveLength(1);
		expect(out).toContain('href="/issues/500A?view=split"');
		expect(out).not.toContain('/issues/500B');
		expect(out).toContain('Unlinked store');
	});
});

describe('toolbar and states', () => {
	it('exposes the view selector and badges as pressed buttons', () => {
		const out = html(CaseListToolbar, { view: 'split', filter: 'waiting', query: 'abc', shownCount: 1, totalCount: 2, storesTotal: 1 });
		expect(out).toContain('aria-label="View"');
		expect(out.match(/aria-pressed="true"/g)).toHaveLength(2);
		expect(out).toContain('value="abc"');
	});
	it.each([
		[{ storesTotal: 0 }, 'No stores yet'],
		[{ storesTotal: 2 }, 'No cases yet'],
		[{ storesTotal: 2, totalCount: 3, query: 'zz' }, 'No cases match "zz"'],
		[{ storesTotal: 2, totalCount: 3 }, 'No cases match the current filter'],
		[{ storesTotal: 2, totalCount: 3, shownCount: 3, storesError: 'down' }, 'Showing the last loaded list'],
		[{ storesError: 'down' }, 'Could not load cases from Salesforce']
	])('%o', (props, text) => expect(html(CaseListStatus, props)).toContain(text));
});

describe('CaseWorkspace', () => {
	const data = {
		storeId: 'store-1', storeName: 'Acme', storeMarketplaces: 'US', storeTotalSaved: null,
		case: { ...row(), asin: 'B000', estimatedRevenueAtRisk: 1200 }, onboarding: null,
		conversation: { kind: 'case', contextType: 'Case', contextId: '500A', available: true, unavailableReason: null, canSend: true, sendDisabledReason: null, messages: [], error: null, currentContactId: 'c' },
		requiredFiles: [], filesError: null, timeline: [], historyError: null, currentUser: { id: 'u', displayName: 'U', sfdcContactId: null }
	};
	const common = ['Listing removed', 'Estimated Revenue at Risk', 'Messages', 'Case Documents', 'Case Timeline', 'action="?/post_message"'];
	it('renders the same workspace in both modes; split adds the full-page and back links', () => {
		const full = html(CaseWorkspace, { data, mode: 'full' });
		const split = html(CaseWorkspace, { data, mode: 'split', canonicalHref: '/stores/store-1/issues/500A', backHref: '/issues?view=split' });
		for (const text of common) {
			expect(full).toContain(text);
			expect(split).toContain(text);
		}
		expect(full).not.toContain('Open full page');
		expect(split).toContain('Open full page');
		expect(split).toContain('href="/stores/store-1/issues/500A"');
		expect(split).toContain('Back to cases');
	});
});
