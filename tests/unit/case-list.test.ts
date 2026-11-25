import { describe, it, expect } from 'vitest';
import {
	caseListHref,
	canonicalCaseHref,
	describeListChange,
	filterIssues,
	matchesIssueFilter,
	parseIssueFilter,
	parseViewMode,
	readStoredView,
	reconcileSelection,
	resolveViewMode,
	writeStoredView,
	VIEW_STORAGE_KEY,
	type IssueFilter
} from '../../src/lib/cases/case-list';

describe('status taxonomy', () => {
	const table: [string, IssueFilter[]][] = [
		['New', ['open']],
		['Open', ['open']],
		['Reopened', ['open']],
		['In Progress', ['in_progress']],
		['Working', ['in_progress']],
		['Waiting on Client', ['waiting']],
		['Pending', ['waiting']],
		['Awaiting Amazon', ['waiting']],
		['Closed', ['resolved']],
		['Resolved', ['resolved']],
		['Escalated', []],
		['Newly assigned', []]
	];
	it.each(table)('%s', (status, expected) => {
		const filters: IssueFilter[] = ['open', 'in_progress', 'waiting', 'resolved'];
		expect(filters.filter((f) => matchesIssueFilter(status, f))).toEqual(expected);
		expect(matchesIssueFilter(status, 'all')).toBe(true);
	});
});

describe('filterIssues', () => {
	const rows = [
		{ CaseNumber: '00001', Subject: 'Listing suspended', storeName: 'Acme', Status: 'New' },
		{ CaseNumber: '00002', Subject: null, storeName: null, Status: 'Working' },
		{ CaseNumber: '00003', Subject: 'A-to-Z claim', storeName: 'Beta Goods', Status: 'Closed' }
	];
	const numbers = (f: IssueFilter, q: string) => filterIssues(rows, f, q).map((r) => r.CaseNumber);
	it('searches case number, subject and store name, ignoring case', () => {
		expect(numbers('all', '00002')).toEqual(['00002']);
		expect(numbers('all', 'SUSPEND')).toEqual(['00001']);
		expect(numbers('all', 'beta')).toEqual(['00003']);
		expect(numbers('all', '   ')).toHaveLength(3);
		expect(numbers('all', 'nothing')).toEqual([]);
	});
	it('combines the badge with the search', () => {
		expect(numbers('resolved', 'a')).toEqual(['00003']);
		expect(numbers('open', 'beta')).toEqual([]);
	});
});

describe('URL state and view preference', () => {
	it('parses view and status, falling back safely', () => {
		expect(parseViewMode('split')).toBe('split');
		expect(parseViewMode('grid')).toBeNull();
		expect(parseViewMode(null)).toBeNull();
		expect(parseIssueFilter('waiting')).toBe('waiting');
		expect(parseIssueFilter('bogus')).toBe('all');
		expect(parseIssueFilter(null)).toBe('all');
	});
	it('prefers the URL, then the case route, then the stored choice, then table', () => {
		expect(resolveViewMode({ urlView: null, stored: null })).toBe('table');
		expect(resolveViewMode({ urlView: null, stored: 'split' })).toBe('split');
		expect(resolveViewMode({ urlView: 'table', stored: 'split' })).toBe('table');
		expect(resolveViewMode({ urlView: 'junk', stored: 'split' })).toBe('split');
		expect(resolveViewMode({ urlView: null, stored: 'table', hasCaseRoute: true })).toBe('split');
	});
	it('round-trips the preference under a versioned key and survives blocked storage', () => {
		const map = new Map<string, string>();
		const store = () => ({ getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) });
		expect(readStoredView(store)).toBeNull();
		writeStoredView(store, 'split');
		expect(map.get(VIEW_STORAGE_KEY)).toBe('split');
		expect(VIEW_STORAGE_KEY).toBe('cases:view:v1');
		expect(readStoredView(store)).toBe('split');
		const blocked = () => { throw new Error('SecurityError'); };
		expect(readStoredView(blocked)).toBeNull();
		expect(() => writeStoredView(blocked, 'table')).not.toThrow();
	});
	it('builds list and selection links that keep search and badge', () => {
		expect(caseListHref({ view: 'table', filter: 'all', query: '' })).toBe('/issues?view=table');
		expect(caseListHref({ view: 'split', filter: 'waiting', query: 'a & b', caseId: '500A' })).toBe('/issues/500A?view=split&status=waiting&q=a+%26+b');
		expect(caseListHref({ view: 'table', filter: 'open', query: '', caseId: '500A' })).toBe('/issues?view=table&status=open&case=500A');
		expect(caseListHref({ view: 'split', filter: 'all', query: '', caseId: null })).toBe('/issues?view=split');
	});
	it('only links cases whose store is local', () => {
		expect(canonicalCaseHref({ Id: '500A', localStoreId: 's1' })).toBe('/stores/s1/issues/500A');
		expect(canonicalCaseHref({ Id: '500A', localStoreId: null })).toBeNull();
	});
});

describe('reconcileSelection', () => {
	const prev = ['a', 'b', 'c', 'd'];
	it('keeps a selection that still matches', () => expect(reconcileSelection(prev, ['b', 'c'], 'c')).toBe('c'));
	it('takes the next visible row', () => expect(reconcileSelection(prev, ['a', 'c', 'd'], 'b')).toBe('c'));
	it('skips rows that also left or cannot be selected', () => expect(reconcileSelection(prev, ['a', 'd'], 'b')).toBe('d'));
	it('falls back to the previous row', () => expect(reconcileSelection(prev, ['a', 'b'], 'd')).toBe('b'));
	it('clears when nothing selectable remains', () => expect(reconcileSelection(prev, [], 'b')).toBeNull());
	it('picks the first selectable row when nothing is selected', () => expect(reconcileSelection([], ['c', 'd'], null)).toBe('c'));
	it('picks the first row for a selection that was never visible', () => expect(reconcileSelection(prev, ['b'], 'zz')).toBe('b'));
	it('uses new rows when every old neighbour left', () => expect(reconcileSelection(['a'], ['n'], 'a')).toBe('n'));
});

describe('describeListChange', () => {
	it('is silent without a change', () => expect(describeListChange({ removed: [] })).toBe(''));
	it('announces removal and the new selection', () =>
		expect(describeListChange({ removed: ['001'], nowSelected: '002' })).toBe(
			'Case 001 no longer matches the current filters and was removed from the list. Case 002 is now selected.'
		));
	it('announces several removals and an empty selection', () =>
		expect(describeListChange({ removed: ['1', '2'], selectionCleared: true })).toContain('2 cases'));
});
