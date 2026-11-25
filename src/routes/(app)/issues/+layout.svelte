<script lang="ts">
	/**
	 * Account-wide Cases: header, search, status badges, view selector, and the
	 * Table / Split views. `view`, `status` and `q` live in the URL; only the last
	 * explicit view choice is remembered (localStorage).
	 *
	 * The visible list is always derived from the latest server data. In split view
	 * the selected case is the child route, and this layout moves it when it drops
	 * out of the visible list.
	 */
	import { onMount, onDestroy } from 'svelte';
	import { get } from 'svelte/store';
	import { browser } from '$app/environment';
	import { goto } from '$app/navigation';
	import { page, navigating } from '$app/stores';
	import Topbar from '$components/layout/Topbar.svelte';
	import CaseListToolbar from '$components/cases/CaseListToolbar.svelte';
	import CaseListStatus from '$components/cases/CaseListStatus.svelte';
	import CaseTable from '$components/cases/CaseTable.svelte';
	import CaseCompactList from '$components/cases/CaseCompactList.svelte';
	import CaseSplitShell from '$components/cases/CaseSplitShell.svelte';
	import {
		caseListHref,
		describeListChange,
		filterIssues,
		parseIssueFilter,
		parseViewMode,
		readStoredView,
		reconcileSelection,
		resolveViewMode,
		writeStoredView,
		type CaseViewMode,
		type IssueFilter,
		type IssueRow
	} from '$lib/cases/case-list';
	import { ISSUES_DEPENDENCY, startVisiblePolling, watchFocusRevalidation } from '$lib/cases/refresh';
	import { refreshCaseData } from '$lib/cases/refresh-client';
	import type { LayoutData } from './$types';

	export let data: LayoutData;

	const CASE_ROUTE = '/(app)/issues/[caseId]';
	const IN_PLACE = { noScroll: true, keepFocus: true } as const;
	const REPLACE = { ...IN_PLACE, replaceState: true } as const;
	const storage = () => localStorage;

	let mounted = false;
	let narrow = false;
	let stored: CaseViewMode | null = null;

	// ── Server data. A failed refresh keeps the last list that loaded. ──
	let lastLoaded = { issues: data.issues, storesTotal: data.storesTotal };
	$: if (!data.storesError) lastLoaded = { issues: data.issues, storesTotal: data.storesTotal };
	$: issues = data.storesError ? lastLoaded.issues : data.issues;
	$: storesTotal = data.storesError ? lastLoaded.storesTotal || data.storesTotal : data.storesTotal;

	// ── URL state ──
	$: params = $page.url.searchParams;
	$: routeCaseId = $page.params.caseId ?? null;
	$: urlView = parseViewMode(params.get('view'));
	$: view = resolveViewMode({ urlView, stored, hasCaseRoute: !!routeCaseId });
	$: filter = parseIssueFilter(params.get('status'));
	$: urlQuery = params.get('q') ?? '';
	// Without `view` in the URL the choice depends on localStorage: wait for the browser.
	$: ready = mounted || urlView !== null;

	// ── Search: filters as you type, written to the URL shortly after ──
	let query = $page.url.searchParams.get('q') ?? '';
	let seenUrlQuery = query;
	let committedQuery = query;
	let searchTimer: ReturnType<typeof setTimeout> | undefined;

	/** Take over a query that arrived from outside (Back/Forward, a link). */
	function adoptUrlQuery(next: string) {
		if (next === seenUrlQuery) return;
		seenUrlQuery = next;
		if (next === committedQuery) return; // our own write; the box may already be ahead
		clearTimeout(searchTimer);
		query = committedQuery = next;
	}
	$: adoptUrlQuery(urlQuery);

	function onSearch(value: string) {
		query = value;
		clearTimeout(searchTimer);
		searchTimer = setTimeout(commitQuery, 200);
	}
	function commitQuery() {
		// Build on a navigation in progress so typing doesn't cancel a selection.
		const target = new URL(get(navigating)?.to?.url ?? $page.url);
		if (target.pathname !== '/issues' && !target.pathname.startsWith('/issues/')) return;
		if (query) target.searchParams.set('q', query);
		else target.searchParams.delete('q');
		committedQuery = query;
		goto(`${target.pathname}${target.search}`, REPLACE);
	}

	// ── Derived list ──
	$: visible = filterIssues(issues, filter, query);
	$: pendingCaseId =
		$navigating?.to?.route.id === CASE_ROUTE ? ($navigating.to.params?.caseId ?? null) : null;
	$: activeCaseId = pendingCaseId ?? routeCaseId;
	$: rememberedCaseId = view === 'split' ? activeCaseId : params.get('case');
	$: detailLoading = !!pendingCaseId && pendingCaseId !== routeCaseId;
	$: splitHref = (caseId: string) => caseListHref({ view: 'split', filter, query, caseId });

	function setFilter(next: IssueFilter) {
		clearTimeout(searchTimer);
		committedQuery = query;
		goto(caseListHref({ view, filter: next, query, caseId: rememberedCaseId }), IN_PLACE);
	}
	function setView(next: CaseViewMode) {
		writeStoredView(storage, next);
		stored = next;
		clearTimeout(searchTimer);
		committedQuery = query;
		goto(caseListHref({ view: next, filter, query, caseId: rememberedCaseId }), IN_PLACE);
	}

	// ── Keep the URL explicit and consistent with the route ──
	$: if (mounted && !$navigating) normalizeUrl(urlView, routeCaseId);
	function normalizeUrl(explicit: CaseViewMode | null, caseId: string | null) {
		if (explicit && !(explicit === 'table' && caseId)) return;
		if (!explicit) stored = readStoredView(storage);
		const next = resolveViewMode({ urlView: explicit, stored, hasCaseRoute: !!caseId });
		goto(
			caseListHref({ view: next, filter, query, caseId: caseId ?? params.get('case') }),
			REPLACE
		);
	}

	// ── Selection reconciliation + announcements ──
	let announcement = '';
	let previousIssues: IssueRow[] | null = null;
	let previousVisible: IssueRow[] = [];
	let reconcileQueued = false;

	function queueReconcile(..._changed: unknown[]) {
		if (!browser || reconcileQueued) return;
		reconcileQueued = true;
		queueMicrotask(reconcile);
	}
	function reconcile() {
		reconcileQueued = false;
		// Wait until the URL, the search box and the route agree with each other.
		if (!mounted || !urlView || get(navigating)?.to || query !== urlQuery) return;
		if (view === 'table' && routeCaseId) return;
		// Nothing has ever loaded: no basis for moving the selection.
		if (data.storesError && issues.length === 0) return;

		const refreshed = previousIssues !== null && previousIssues !== issues;
		const stillVisible = new Set(visible.map((c) => c.Id));
		const removed = refreshed
			? previousVisible.filter((c) => !stillVisible.has(c.Id)).map((c) => c.CaseNumber)
			: [];
		let nowSelected: string | null = null;
		let selectionCleared = false;

		if (view === 'split') {
			const next = reconcileSelection(
				previousVisible.map((c) => c.Id),
				visible.filter((c) => c.localStoreId).map((c) => c.Id),
				routeCaseId
			);
			if (routeCaseId && next !== routeCaseId) {
				goto(caseListHref({ view, filter, query, caseId: next }), REPLACE);
				nowSelected = visible.find((c) => c.Id === next)?.CaseNumber ?? null;
				selectionCleared = !next;
			} else if (!routeCaseId && next && !narrow) {
				// Narrow screens are list-first: nothing is opened until it's chosen.
				goto(splitHref(next), REPLACE);
			}
		}

		const message = describeListChange({ removed, nowSelected, selectionCleared });
		if (message) announcement = message;
		previousIssues = issues;
		previousVisible = visible;
	}
	$: queueReconcile(mounted, view, urlView, narrow, issues, visible, routeCaseId, urlQuery, $navigating);

	// ── Revalidation ──
	const refreshList = () => void refreshCaseData(ISSUES_DEPENDENCY);
	let stopPolling: (() => void) | null = null;
	function setPolling(on: boolean) {
		if (on) stopPolling ??= startVisiblePolling({ refresh: refreshList, doc: document });
		else {
			stopPolling?.();
			stopPolling = null;
		}
	}
	$: if (mounted) setPolling(view === 'split');

	onMount(() => {
		const media = window.matchMedia('(max-width: 900px)');
		const onMedia = () => (narrow = media.matches);
		onMedia();
		media.addEventListener('change', onMedia);
		const stopFocus = watchFocusRevalidation({ refresh: refreshList, win: window, doc: document });
		stored = readStoredView(storage);
		mounted = true;
		return () => {
			media.removeEventListener('change', onMedia);
			stopFocus();
			setPolling(false);
		};
	});
	onDestroy(() => clearTimeout(searchTimer));
</script>

<svelte:head><title>Cases — Appeals Doctor</title></svelte:head>

<Topbar
	title="Cases"
	subtitle="Cases across all your stores"
	crumbs={[{ label: 'Dashboard', href: '/dashboard' }, { label: 'Cases' }]}
/>

<div class="sr-only" role="status" aria-live="polite">{announcement}</div>

{#if !ready}
	<div class="content-area" aria-busy="true"></div>
{:else if view === 'table'}
	<div class="content-area">
		<CaseListToolbar
			{query}
			{filter}
			{view}
			shownCount={visible.length}
			totalCount={issues.length}
			{storesTotal}
			{onSearch}
			onFilter={setFilter}
			onView={setView}
		/>
		<CaseListStatus
			storesError={data.storesError}
			{storesTotal}
			totalCount={issues.length}
			shownCount={visible.length}
			{query}
		/>
		{#if visible.length > 0}
			<CaseTable cases={visible} selectedId={params.get('case')} />
		{/if}
	</div>
{:else}
	<CaseSplitShell hasSelection={!!activeCaseId} loading={detailLoading} selectionKey={routeCaseId}>
		<CaseListToolbar
			slot="toolbar"
			{query}
			{filter}
			{view}
			shownCount={visible.length}
			totalCount={issues.length}
			{storesTotal}
			{onSearch}
			onFilter={setFilter}
			onView={setView}
		/>
		<svelte:fragment slot="list">
			<div class="list-status">
				<CaseListStatus
					storesError={data.storesError}
					{storesTotal}
					totalCount={issues.length}
					shownCount={visible.length}
					{query}
				/>
			</div>
			{#if visible.length > 0}
				<CaseCompactList cases={visible} selectedId={activeCaseId} hrefFor={splitHref} />
			{/if}
		</svelte:fragment>
		<slot />
	</CaseSplitShell>
{/if}

<style>
	.content-area { flex: 1; overflow-y: auto; padding: 22px 26px; }
	.list-status:not(:empty) { padding: 12px 16px 0; }
	.sr-only {
		position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
		overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0;
	}
</style>
