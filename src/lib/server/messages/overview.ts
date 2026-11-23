/**
 * Account-wide messages overview for the Messages tab: unread counts and latest
 * activity for the Account conversation, every Store conversation and the Cases
 * under those stores.
 *
 * buildMessagesOverview() is pure (unit-tested); loadMessagesOverview() does the
 * I/O. Only this tenant's own local stores / Salesforce ids are ever queried.
 */
import { sql } from '$lib/server/db';
import {
	listCasesForStores,
	listRecentAppMessagesForContexts,
	type CaseSummaryWithStore
} from '$lib/server/salesforce';
import { plainPreview } from '$lib/components/messages/conversation-utils';
import type { AppMessageWithContext } from '$lib/types/app-message';

const MESSAGE_SCAN_LIMIT = 200; // per context type
const CASE_SCAN_LIMIT = 200;
const CASES_SHOWN_PER_STORE = 5;

export interface OverviewStoreInput {
	id: string;
	name: string;
	sfdc_store_id: string | null;
}

export interface OverviewLastMessage {
	author: string;
	preview: string;
	createdAt: string;
	/** Where it was posted: the store's own chat or one of its cases. */
	source: 'store' | 'case';
	caseNumber: string | null;
}

export interface OverviewCase {
	id: string;
	number: string;
	label: string;
	unread: number;
	href: string;
}

export interface OverviewStore {
	id: string;
	name: string;
	linked: boolean;
	href: string;
	storeUnread: number;
	caseUnread: number;
	totalUnread: number;
	caseCount: number;
	cases: OverviewCase[];
	lastMessage: OverviewLastMessage | null;
}

export interface MessagesOverview {
	accountUnread: number;
	stores: OverviewStore[];
	/** Unread across Account + Stores + Cases. */
	totalUnread: number;
	/** True when a context could not be loaded, so counts may be incomplete. */
	partial: boolean;
}

export interface OverviewInput {
	stores: OverviewStoreInput[];
	cases: Pick<CaseSummaryWithStore, 'Id' | 'CaseNumber' | 'Subject' | 'recordTypeName' | 'sfdcStoreId'>[];
	/** Recent messages per context (undefined = failed to load). Read + unread. */
	accountMessages?: AppMessageWithContext[];
	storeMessages?: AppMessageWithContext[];
	caseMessages?: AppMessageWithContext[];
	currentContactId: string | null;
}

const authorOf = (m: AppMessageWithContext) =>
	m.displayName ?? m.senderContactName ?? m.createdByName ?? 'Someone';

export function buildMessagesOverview(input: OverviewInput): MessagesOverview {
	const mine = (m: AppMessageWithContext) =>
		!!input.currentContactId && m.senderContactId === input.currentContactId;
	const unread = (m: AppMessageWithContext) => !m.messageRead && !mine(m);
	const countBy = (msgs: AppMessageWithContext[] | undefined) => {
		const map = new Map<string, number>();
		for (const m of msgs ?? []) if (unread(m)) map.set(m.contextId, (map.get(m.contextId) ?? 0) + 1);
		return map;
	};

	const storeUnread = countBy(input.storeMessages);
	const caseUnread = countBy(input.caseMessages);
	const accountUnread = (input.accountMessages ?? []).filter(unread).length;

	const casesByStore = new Map<string, OverviewInput['cases']>();
	const storeIdByCase = new Map<string, string>(); // SF case id → SF store id
	for (const c of input.cases) {
		if (!c.sfdcStoreId) continue;
		storeIdByCase.set(c.Id, c.sfdcStoreId);
		casesByStore.set(c.sfdcStoreId, [...(casesByStore.get(c.sfdcStoreId) ?? []), c]);
	}

	// Latest message per store, across its own chat and its cases.
	const lastByStore = new Map<string, AppMessageWithContext & { source: 'store' | 'case' }>();
	const consider = (sfStoreId: string | undefined, m: AppMessageWithContext, source: 'store' | 'case') => {
		if (!sfStoreId) return;
		const cur = lastByStore.get(sfStoreId);
		if (!cur || new Date(m.createdAt) > new Date(cur.createdAt)) lastByStore.set(sfStoreId, { ...m, source });
	};
	for (const m of input.storeMessages ?? []) consider(m.contextId, m, 'store');
	for (const m of input.caseMessages ?? []) consider(storeIdByCase.get(m.contextId), m, 'case');

	const stores: OverviewStore[] = input.stores.map((s) => {
		const sf = s.sfdc_store_id;
		const cases = sf ? (casesByStore.get(sf) ?? []) : [];
		const caseRows: OverviewCase[] = cases
			.map((c) => ({
				id: c.Id,
				number: c.CaseNumber,
				label: `Case #${c.CaseNumber}${c.Subject || c.recordTypeName ? ` · ${c.Subject ?? c.recordTypeName}` : ''}`,
				unread: caseUnread.get(c.Id) ?? 0,
				href: `/stores/${s.id}/issues/${c.Id}`
			}))
			.sort((a, b) => b.unread - a.unread)
			.slice(0, CASES_SHOWN_PER_STORE);
		const sUnread = sf ? (storeUnread.get(sf) ?? 0) : 0;
		const cUnread = cases.reduce((n, c) => n + (caseUnread.get(c.Id) ?? 0), 0);
		const last = sf ? lastByStore.get(sf) : undefined;
		return {
			id: s.id,
			name: s.name,
			linked: !!sf,
			href: `/stores/${s.id}#store-messages`,
			storeUnread: sUnread,
			caseUnread: cUnread,
			totalUnread: sUnread + cUnread,
			caseCount: cases.length,
			cases: caseRows,
			lastMessage: last
				? {
						author: authorOf(last),
						preview: plainPreview(last.body, 90),
						createdAt: last.createdAt,
						source: last.source,
						caseNumber: last.caseNumber
					}
				: null
		};
	});
	// Stores with unread first, then alphabetically.
	stores.sort((a, b) => b.totalUnread - a.totalUnread || a.name.localeCompare(b.name));

	return {
		accountUnread,
		stores,
		totalUnread: accountUnread + stores.reduce((n, s) => n + s.totalUnread, 0),
		partial:
			input.accountMessages === undefined ||
			input.storeMessages === undefined ||
			input.caseMessages === undefined
	};
}

/** Load everything the overview needs for the signed-in user's own account. */
export async function loadMessagesOverview(
	user: { id: string },
	accountId: string,
	sfdcAccountId: string | null,
	currentContactId: string | null
): Promise<MessagesOverview> {
	const stores = await sql<OverviewStoreInput[]>`
		SELECT id, name, sfdc_store_id FROM stores WHERE account_id = ${accountId} ORDER BY name
	`;
	const sfStoreIds = stores.map((s) => s.sfdc_store_id).filter((x): x is string => !!x);
	const ctx = { userId: user.id, accountId };

	const casesResult = sfStoreIds.length
		? await listCasesForStores(sfStoreIds, ctx).catch(() => ({ ok: false as const, error: 'x' }))
		: { ok: true as const, cases: [] as CaseSummaryWithStore[] };
	const cases = casesResult.ok ? casesResult.cases : [];
	const caseIds = cases.map((c) => c.Id).slice(0, CASE_SCAN_LIMIT);

	const fetchMsgs = async (type: 'Account' | 'Store__c' | 'Case', ids: string[]) => {
		if (ids.length === 0) return [] as AppMessageWithContext[];
		const r = await listRecentAppMessagesForContexts(type, ids, MESSAGE_SCAN_LIMIT, ctx).catch(
			() => ({ ok: false as const })
		);
		return r.ok ? r.messages : undefined;
	};
	const [accountMessages, storeMessages, caseMessages] = await Promise.all([
		fetchMsgs('Account', sfdcAccountId ? [sfdcAccountId] : []),
		fetchMsgs('Store__c', sfStoreIds),
		fetchMsgs('Case', caseIds)
	]);

	const overview = buildMessagesOverview({
		stores,
		cases,
		accountMessages,
		storeMessages,
		caseMessages,
		currentContactId
	});
	return casesResult.ok ? overview : { ...overview, partial: true };
}
