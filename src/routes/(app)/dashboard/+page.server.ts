/**
 * Dashboard load — assembles a single view across:
 *   - Local users / accounts / stores
 *   - Salesforce Cases (across all account stores, one SOQL)
 *   - Salesforce Case_Message__c (most recent, across all those cases)
 *   - Salesforce Case_File__c (pending only, across all those cases)
 *
 * Each SF source can fail independently — the page renders with whatever is
 * available and surfaces non-fatal errors inline.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { sql } from '$lib/server/db';
import {
	listCasesForStores,
	listRecentMessagesForCases,
	listRequiredFilesForStores,
	listRequiredFilesForCases,
	listOnboardingStatusForCases,
	getCaseSteps
} from '$lib/server/salesforce';
import { listOutstandingContracts } from '$lib/server/payments/outstanding';
import { sanitizeMessageHtml } from '$lib/server/sanitize';

const RECENT_CASES_LIMIT = 6;
const RECENT_COMMENTS_LIMIT = 6;
const REQUIRED_FILES_LIMIT = 8;
// Cap how many cases we roll required files up for (SOQL IN-clause length).
const CASE_SCAN_LIMIT = 200;

interface DashRequiredFile {
	id: string;
	name: string;
	shortDescription: string | null;
	acceptedFormats: string[];
	context: 'store' | 'case';
	localStoreId: string | null;
	storeName: string | null;
	caseId: string | null;
	caseNumber: string | null;
	href: string;
}

/** One row of the "Action required" block: a store or a case, with everything still owed on it. */
interface DashAction {
	key: string;
	scope: 'store' | 'case';
	title: string;
	subtitle: string | null;
	href: string;
	todos: { kind: 'file' | 'onboarding'; text: string }[];
}

interface StoreRow {
	id: string;
	name: string;
	marketplaces: string | null;
	sfdc_store_id: string | null;
	spapi_status: string;
}

function isResolved(status: string): boolean {
	const s = status.toLowerCase();
	return s.includes('closed') || s.includes('resolved');
}
function isInProgress(status: string): boolean {
	const s = status.toLowerCase();
	return s.includes('progress') || s.includes('working');
}
function isWaiting(status: string): boolean {
	const s = status.toLowerCase();
	return s.includes('waiting') || s.includes('pending') || s.includes('awaiting');
}
function isOpen(status: string): boolean {
	return !isResolved(status);
}
function startOfMonth(): number {
	const d = new Date();
	d.setUTCDate(1);
	d.setUTCHours(0, 0, 0, 0);
	return d.getTime();
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw redirect(303, '/login');

	// ── Local rows ──
	const [user] = await sql<
		{ id: string; email: string; display_name: string | null; account_id: string | null }[]
	>`
		SELECT id, email, display_name, account_id
		FROM users WHERE id = ${locals.user.id} LIMIT 1
	`;
	const account = user?.account_id
		? (
				await sql<{ id: string; name: string; sfdc_account_id: string | null }[]>`
					SELECT id, name, sfdc_account_id FROM accounts WHERE id = ${user.account_id} LIMIT 1
				`
			)[0] ?? null
		: null;

	const stores = user?.account_id
		? await sql<StoreRow[]>`
				SELECT id, name, marketplaces, sfdc_store_id, spapi_status
				FROM stores WHERE account_id = ${user.account_id}
				ORDER BY created_at DESC
			`
		: [];

	const storeBySfdcId = new Map<string, { localId: string; name: string }>();
	for (const s of stores) {
		if (s.sfdc_store_id) storeBySfdcId.set(s.sfdc_store_id, { localId: s.id, name: s.name });
	}
	const sfdcStoreIds = [...storeBySfdcId.keys()];

	// ── SF rollups (parallel) ──
	const ctx = { userId: locals.user.id, accountId: user?.account_id ?? undefined };
	const casesResult = await listCasesForStores(sfdcStoreIds, ctx);
	const cases = casesResult.ok ? casesResult.cases : [];
	const casesError = casesResult.ok ? null : casesResult.error;
	const caseIds = cases.map((c) => c.Id);

	// Index cases by Id so we can look up store name / case number on each row.
	const caseStoreById = new Map<string, { localStoreId: string | null; storeName: string | null }>();
	const caseNumberById = new Map<string, string>();
	for (const c of cases) {
		const local = c.sfdcStoreId ? storeBySfdcId.get(c.sfdcStoreId) ?? null : null;
		caseStoreById.set(c.Id, {
			localStoreId: local?.localId ?? null,
			storeName: local?.name ?? null
		});
		caseNumberById.set(c.Id, c.CaseNumber);
	}

	// ── Comments + Required files (Required_File__c across stores AND cases) ──
	const [commentsResult, storeFilesResult, caseFilesResult] = await Promise.all([
		listRecentMessagesForCases(caseIds, RECENT_COMMENTS_LIMIT, ctx),
		sfdcStoreIds.length
			? listRequiredFilesForStores(sfdcStoreIds)
			: Promise.resolve({ ok: true as const, files: [] }),
		caseIds.length
			? listRequiredFilesForCases(caseIds.slice(0, CASE_SCAN_LIMIT))
			: Promise.resolve({ ok: true as const, files: [] })
	]);

	// Consolidate pending (not-yet-uploaded) required files across both contexts.
	const pendingRequired: DashRequiredFile[] = [];
	let requiredTotalSlots = 0;
	let requiredUploaded = 0;
	let requiredFilesError: string | null = null;

	if (storeFilesResult.ok) {
		for (const f of storeFilesResult.files) {
			requiredTotalSlots++;
			if (f.uploaded) {
				requiredUploaded++;
				continue;
			}
			const local = storeBySfdcId.get(f.parentId) ?? null;
			pendingRequired.push({
				id: f.id,
				name: f.name,
				shortDescription: f.shortDescription,
				acceptedFormats: f.acceptedFormats,
				context: 'store',
				localStoreId: local?.localId ?? null,
				storeName: local?.name ?? null,
				caseId: null,
				caseNumber: null,
				href: local?.localId ? `/stores/${local.localId}` : '/stores'
			});
		}
	} else {
		requiredFilesError = storeFilesResult.error;
	}

	if (caseFilesResult.ok) {
		for (const f of caseFilesResult.files) {
			requiredTotalSlots++;
			if (f.uploaded) {
				requiredUploaded++;
				continue;
			}
			const loc = caseStoreById.get(f.parentId) ?? null;
			pendingRequired.push({
				id: f.id,
				name: f.name,
				shortDescription: f.shortDescription,
				acceptedFormats: f.acceptedFormats,
				context: 'case',
				localStoreId: loc?.localStoreId ?? null,
				storeName: loc?.storeName ?? null,
				caseId: f.parentId,
				caseNumber: caseNumberById.get(f.parentId) ?? null,
				href: loc?.localStoreId
					? `/stores/${loc.localStoreId}/issues/${f.parentId}`
					: '/issues'
			});
		}
	} else {
		requiredFilesError = requiredFilesError ?? caseFilesResult.error;
	}

	// ── Action required: pending files + onboarding info, grouped per store / case ──
	const openCaseIds = cases.filter((c) => !isResolved(c.Status)).map((c) => c.Id);
	const onboardingStatus = await listOnboardingStatusForCases(openCaseIds.slice(0, CASE_SCAN_LIMIT));

	const actionMap = new Map<string, DashAction>();
	for (const f of pendingRequired) {
		const key = f.context === 'case' ? `case:${f.caseId}` : `store:${f.localStoreId ?? f.storeName}`;
		let a = actionMap.get(key);
		if (!a) {
			a =
				f.context === 'case'
					? {
							key,
							scope: 'case',
							title: `Case ${f.caseNumber ?? (f.caseId ? f.caseId.slice(0, 8) : '—')}`,
							subtitle: f.storeName,
							href: f.href,
							todos: []
						}
					: { key, scope: 'store', title: `Store: ${f.storeName ?? '—'}`, subtitle: null, href: f.href, todos: [] };
			actionMap.set(key, a);
		}
		a.todos.push({ kind: 'file', text: `Not uploaded: ${f.name}` });
	}
	for (const [caseId, o] of onboardingStatus) {
		if (o.provided) continue;
		const key = `case:${caseId}`;
		const loc = caseStoreById.get(caseId) ?? null;
		let a = actionMap.get(key);
		if (!a) {
			a = {
				key,
				scope: 'case',
				title: `Case ${caseNumberById.get(caseId) ?? caseId.slice(0, 8)}`,
				subtitle: loc?.storeName ?? null,
				href: loc?.localStoreId ? `/stores/${loc.localStoreId}/issues/${caseId}` : '/issues',
				todos: []
			};
			actionMap.set(key, a);
		}
		a.todos.unshift({ kind: 'onboarding', text: 'Onboarding information not provided' });
	}
	const allActions = [...actionMap.values()];
	const actions = allActions.slice(0, REQUIRED_FILES_LIMIT);
	const actionSummary = {
		todos: allActions.reduce((n, a) => n + a.todos.length, 0),
		rows: allActions.length
	};

	// ── Stats ──
	const monthStart = startOfMonth();
	const stats = {
		totalStores: stores.length,
		connectedStores: stores.filter((s) => s.spapi_status === 'connected').length,
		totalCases: cases.length,
		openCases: cases.filter((c) => isOpen(c.Status)).length,
		inProgressCases: cases.filter((c) => isInProgress(c.Status)).length,
		waitingCases: cases.filter((c) => isWaiting(c.Status)).length,
		resolvedThisMonth: cases.filter(
			(c) => isResolved(c.Status) && new Date(c.LastModifiedDate).getTime() >= monthStart
		).length,
		// Total outstanding actions (pending files + missing onboarding info).
		pendingFiles: actionSummary.todos
	};

	// ── Recent issues table (newest by LastModifiedDate) ──
	const recentCasesBase = [...cases]
		.sort(
			(a, b) =>
				new Date(b.LastModifiedDate).getTime() - new Date(a.LastModifiedDate).getTime()
		)
		.slice(0, RECENT_CASES_LIMIT);
	// Outstanding documents / onboarding info for the open cases shown in the table.
	const recentSteps = await getCaseSteps(
		recentCasesBase.filter((c) => !/closed|resolved/i.test(c.Status)).map((c) => c.Id)
	);
	const recentCases = recentCasesBase
		.map((c) => ({
			Id: c.Id,
			CaseNumber: c.CaseNumber,
			Subject: c.Subject,
			recordTypeName: c.recordTypeName,
			Status: c.Status,
			Priority: c.Priority,
			LastModifiedDate: c.LastModifiedDate,
			steps: recentSteps.get(c.Id),
			...caseStoreById.get(c.Id)
		}));

	const recentComments = (commentsResult.ok ? commentsResult.messages : []).map((m) => ({
		...m,
		// Rendered with {@html} in the feed → sanitize the rich-text body here.
		body: sanitizeMessageHtml(m.body),
		...caseStoreById.get(m.caseId)
	}));
	const commentsError = commentsResult.ok ? null : commentsResult.error;

	let outstanding: Awaited<ReturnType<typeof listOutstandingContracts>> = [];
	try {
		outstanding = await listOutstandingContracts(account?.sfdc_account_id ?? null);
	} catch {
		outstanding = []; // best-effort: never break the dashboard
	}

	return {
		outstanding,
		account: account
			? {
					id: account.id,
					name: account.name,
					sfdcAccountId: account.sfdc_account_id,
					email: user?.email ?? null,
					displayName: user?.display_name ?? user?.email ?? null
				}
			: null,
		stats,
		recentCases,
		recentComments,
		actions,
		actionSummary,
		requiredSummary: {
			pending: pendingRequired.length,
			uploaded: requiredUploaded,
			total: requiredTotalSlots
		},
		errors: {
			cases: casesError,
			comments: commentsError,
			requiredFiles: requiredFilesError
		}
	};
};
