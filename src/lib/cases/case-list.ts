/**
 * Case list rules shared by the account-wide Cases page (table + split view) and
 * the store page: status taxonomy, search, URL state, view preference and
 * selection reconciliation. Pure functions only — safe on server and client.
 */
import type { CaseSummaryWithStore } from '$lib/server/salesforce/cases';
import type { CaseSteps } from '$lib/server/salesforce/case-steps';

export interface IssueRow extends CaseSummaryWithStore {
	localStoreId: string | null;
	storeName: string | null;
	/** Outstanding documents / onboarding info; undefined for closed cases. */
	steps?: CaseSteps;
}

export type IssueFilter = 'all' | 'open' | 'in_progress' | 'waiting' | 'resolved';
export type CaseViewMode = 'table' | 'split';

export const ISSUE_FILTERS: readonly { id: IssueFilter; label: string }[] = [
	{ id: 'all', label: 'All' },
	{ id: 'open', label: 'Open' },
	{ id: 'in_progress', label: 'In progress' },
	{ id: 'waiting', label: 'Waiting' },
	{ id: 'resolved', label: 'Resolved' }
];

export function filterLabel(filter: IssueFilter): string {
	return ISSUE_FILTERS.find((f) => f.id === filter)?.label ?? 'All';
}

// ─── Status taxonomy ────────────────────────────────────────────────────

export function isWaitingOnClient(status: string): boolean {
	const s = status.toLowerCase();
	return s.includes('waiting') || s.includes('pending') || s.includes('awaiting');
}

export function isResolved(status: string): boolean {
	const s = status.toLowerCase();
	return s.includes('closed') || s.includes('resolved');
}

export function matchesIssueFilter(status: string, filter: IssueFilter): boolean {
	if (filter === 'all') return true;
	const s = status.toLowerCase();
	if (filter === 'open') return s.includes('open') || s === 'new';
	if (filter === 'in_progress') return s.includes('progress') || s.includes('working');
	if (filter === 'waiting') return isWaitingOnClient(status);
	if (filter === 'resolved') return isResolved(status);
	return false;
}

type SearchableCase = Pick<IssueRow, 'Status' | 'CaseNumber' | 'Subject' | 'storeName'>;

/** Status badge + case-insensitive search over case number, subject and store name. */
export function filterIssues<T extends SearchableCase>(issues: T[], filter: IssueFilter, query: string): T[] {
	const q = query.toLowerCase();
	const searching = query.trim() !== '';
	return issues.filter((c) => {
		if (!matchesIssueFilter(c.Status, filter)) return false;
		if (!searching) return true;
		return (
			c.CaseNumber.toLowerCase().includes(q) ||
			(c.Subject ?? '').toLowerCase().includes(q) ||
			(c.storeName ?? '').toLowerCase().includes(q)
		);
	});
}

// ─── Presentation ───────────────────────────────────────────────────────

export function statusVariant(status: string): 'green' | 'orange' | 'grey' | 'red' {
	if (isResolved(status)) return 'green';
	if (isWaitingOnClient(status)) return 'red';
	const s = status.toLowerCase();
	if (s.includes('progress') || s.includes('working')) return 'orange';
	return 'grey'; // Open / New
}

export function priorityVariant(priority: string | null): 'red' | 'orange' | 'grey' {
	if (!priority) return 'grey';
	const p = priority.toLowerCase();
	if (p.includes('critical') || p.includes('high')) return 'red';
	if (p.includes('medium')) return 'orange';
	return 'grey';
}

export function fmtDateShort(iso: string | null | undefined): string {
	if (!iso) return '—';
	try {
		return new Date(iso).toLocaleDateString();
	} catch {
		return iso;
	}
}

// ─── Links ──────────────────────────────────────────────────────────────

/** Canonical full-page URL; null when the case's store isn't local (nothing to link to). */
export function canonicalCaseHref(c: Pick<IssueRow, 'Id' | 'localStoreId'>): string | null {
	return c.localStoreId ? `/stores/${c.localStoreId}/issues/${c.Id}` : null;
}

export interface CaseListState {
	view: CaseViewMode;
	filter: IssueFilter;
	query: string;
	/** Selected case: a path segment in split view, `?case=` (remembered only) in table view. */
	caseId?: string | null;
}

export function caseListHref({ view, filter, query, caseId }: CaseListState): string {
	const params = new URLSearchParams({ view });
	if (filter !== 'all') params.set('status', filter);
	if (query !== '') params.set('q', query);
	if (view === 'table') {
		if (caseId) params.set('case', caseId);
		return `/issues?${params}`;
	}
	return `/issues${caseId ? `/${encodeURIComponent(caseId)}` : ''}?${params}`;
}

// ─── URL parsing + view preference ──────────────────────────────────────

export function parseViewMode(value: string | null | undefined): CaseViewMode | null {
	return value === 'table' || value === 'split' ? value : null;
}

export function parseIssueFilter(value: string | null | undefined): IssueFilter {
	return ISSUE_FILTERS.find((f) => f.id === value)?.id ?? 'all';
}

/**
 * URL wins; a selected-case route without `view` is split (the path asks for the
 * detail pane); otherwise the stored preference, otherwise Table.
 */
export function resolveViewMode(input: {
	urlView: string | null | undefined;
	stored: CaseViewMode | null;
	hasCaseRoute?: boolean;
}): CaseViewMode {
	return parseViewMode(input.urlView) ?? (input.hasCaseRoute ? 'split' : (input.stored ?? 'table'));
}

export const VIEW_STORAGE_KEY = 'cases:view:v1';

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;

/** localStorage can throw (privacy mode, blocked storage) — a lost preference is not an error. */
export function readStoredView(storage: () => KeyValueStore): CaseViewMode | null {
	try {
		return parseViewMode(storage().getItem(VIEW_STORAGE_KEY));
	} catch {
		return null;
	}
}

export function writeStoredView(storage: () => KeyValueStore, view: CaseViewMode): void {
	try {
		storage().setItem(VIEW_STORAGE_KEY, view);
	} catch {
		/* ignore */
	}
}

// ─── Selection reconciliation ───────────────────────────────────────────

/**
 * Which case should be selected after the visible list changed.
 *
 * Keeps the selection while it is still selectable and visible. Otherwise takes
 * the next selectable row after its old position, then the previous one, then the
 * first selectable row. Returns null when nothing selectable matches.
 */
export function reconcileSelection(
	previousVisibleIds: readonly string[],
	nextSelectableIds: readonly string[],
	selectedId: string | null
): string | null {
	const selectable = new Set(nextSelectableIds);
	if (selectedId && selectable.has(selectedId)) return selectedId;
	const at = selectedId ? previousVisibleIds.indexOf(selectedId) : -1;
	if (at >= 0) {
		for (let i = at + 1; i < previousVisibleIds.length; i++) {
			if (selectable.has(previousVisibleIds[i])) return previousVisibleIds[i];
		}
		for (let i = at - 1; i >= 0; i--) {
			if (selectable.has(previousVisibleIds[i])) return previousVisibleIds[i];
		}
	}
	return nextSelectableIds[0] ?? null;
}

/** Text for the polite live region; empty when there is nothing worth announcing. */
export function describeListChange(input: {
	removed: readonly string[];
	/** Case number now selected because the previous one left the list. */
	nowSelected?: string | null;
	selectionCleared?: boolean;
}): string {
	const parts: string[] = [];
	if (input.removed.length === 1) {
		parts.push(`Case ${input.removed[0]} no longer matches the current filters and was removed from the list.`);
	} else if (input.removed.length > 1) {
		parts.push(`${input.removed.length} cases no longer match the current filters and were removed from the list.`);
	}
	if (input.nowSelected) parts.push(`Case ${input.nowSelected} is now selected.`);
	else if (input.selectionCleared) parts.push('No matching case is selected.');
	return parts.join(' ');
}
