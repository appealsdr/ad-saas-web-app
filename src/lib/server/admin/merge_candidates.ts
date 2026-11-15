/**
 * Admin "Account merge" (AD-1944) — step 1 of any merge: find platform accounts that are probably the same customer.
 * Read-only. The merge itself is specified in docs/account-merge-proposal.md and is not implemented yet.
 *
 * Signals (strongest first):
 *   email    same canonical mailbox (Gmail dots / +tags collapsed) on any account email or user email
 *   website  same website host
 *   name     same company name after dropping LLC/Inc/etc.
 */
import { sql } from '../db';
import { canonicalEmailKey } from '../auth/signup_validation';

export interface AccountLite {
	id: string;
	name: string;
	emails: string[];
	website: string | null;
	sfdc_account_id: string | null;
	user_count: number;
	store_count: number;
	contract_count: number;
	created_at: Date | string;
}
export type DupSignal = 'email' | 'website' | 'name';
export interface DupGroup { signal: DupSignal; key: string; accounts: AccountLite[] }

const GENERIC_HOSTS = new Set(['gmail.com', 'yahoo.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'facebook.com', 'amazon.com', 'linkedin.com']);

export function hostKey(website: string | null): string | null {
	if (!website) return null;
	try {
		const h = new URL(/^https?:\/\//i.test(website.trim()) ? website.trim() : `https://${website.trim()}`).hostname.toLowerCase().replace(/^www\./, '');
		return h && h.includes('.') && !GENERIC_HOSTS.has(h) ? h : null;
	} catch {
		return null;
	}
}

export const nameKey = (name: string): string =>
	name.toLowerCase().replace(/\b(llc|l\.l\.c|inc|ltd|co|corp|corporation|company)\b\.?/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Pure: group accounts by shared signals. An account pair is reported once, under its strongest signal. */
export function findDuplicateGroups(accounts: AccountLite[]): DupGroup[] {
	const groups: DupGroup[] = [];
	const paired = new Set<string>();
	const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

	const collect = (signal: DupSignal, keysOf: (a: AccountLite) => string[]) => {
		const buckets = new Map<string, AccountLite[]>();
		for (const a of accounts) for (const k of new Set(keysOf(a))) {
			const list = buckets.get(k) ?? [];
			list.push(a);
			buckets.set(k, list);
		}
		for (const [key, list] of buckets) {
			if (list.length < 2) continue;
			// Skip a bucket whose every pair was already reported under a stronger signal.
			let fresh = false;
			for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
				const pk = pairKey(list[i].id, list[j].id);
				if (!paired.has(pk)) { fresh = true; paired.add(pk); }
			}
			if (fresh) groups.push({ signal, key, accounts: list });
		}
	};

	collect('email', (a) => a.emails.filter(Boolean).map((e) => canonicalEmailKey(e)));
	collect('website', (a) => [hostKey(a.website)].filter((h): h is string => !!h));
	collect('name', (a) => (nameKey(a.name).length >= 3 ? [nameKey(a.name)] : []));
	return groups;
}

/** Load accounts (bounded) and return duplicate groups. */
export async function listDuplicateGroups(limit = 5000): Promise<{ groups: DupGroup[]; scanned: number }> {
	// Retired (already merged) accounts are not candidates. The column only exists after migration 036, so fall back without it.
	const query = (excludeMerged: boolean) => sql<(Omit<AccountLite, 'emails'> & { emails: string[] | null })[]>`
		SELECT a.id, a.name, a.website, a.sfdc_account_id, a.created_at,
		       array_remove(array_agg(DISTINCT lower(u.email)) || array[lower(a.email)], NULL) AS emails,
		       (SELECT count(*)::int FROM users u2 WHERE u2.account_id = a.id) AS user_count,
		       (SELECT count(*)::int FROM stores s WHERE s.account_id = a.id) AS store_count,
		       (SELECT count(*)::int FROM service_contracts c WHERE c.account_id = a.id) AS contract_count
		FROM accounts a LEFT JOIN users u ON u.account_id = a.id
		${excludeMerged ? sql`WHERE a.merged_into_account_id IS NULL` : sql``}
		GROUP BY a.id
		ORDER BY a.created_at DESC
		LIMIT ${limit}`;
	let rows;
	try {
		rows = await query(true);
	} catch (e) {
		if ((e as { code?: string })?.code !== '42703') throw e;
		rows = await query(false);
	}
	const accounts = rows.map((r) => ({ ...r, emails: r.emails ?? [] }));
	return { groups: findDuplicateGroups(accounts), scanned: accounts.length };
}
