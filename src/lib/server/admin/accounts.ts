/**
 * Staff-side account & user queries. These deliberately take an explicit
 * target account id AFTER the caller has passed a permission guard, and every
 * child lookup re-checks that the child belongs to that account — customer
 * routes (which filter by the session's own account) are untouched.
 *
 * Derived values (documented, never invented):
 *   onboarding_status  accounts.onboarding_completed → 'complete' | 'incomplete'
 *   owner              the earliest user with users.role='owner' on the account;
 *                      else the account's own contact email; else null (unknown)
 *   sfdc link          accounts.sfdc_account_id present → 'linked' (existence only, not health)
 */
import { sql } from '../db';
import { likeContains, parsePage, parsePageSize } from './pagination';

export type AccountSort = 'created' | 'name' | 'users' | 'stores';

export interface AccountListRow {
	id: string;
	name: string;
	account_email: string | null;
	owner_email: string | null;
	owner_name: string | null;
	user_count: number;
	store_count: number;
	onboarding_completed: boolean;
	sfdc_account_id: string | null;
	created_at: Date;
}

export interface AccountListQuery {
	q?: string;
	onboarding?: 'complete' | 'incomplete' | '';
	sort?: AccountSort;
	dir?: 'asc' | 'desc';
	page?: number;
	pageSize?: number;
}

export function parseAccountListQuery(params: URLSearchParams): Required<AccountListQuery> {
	const sort = (['created', 'name', 'users', 'stores'] as const).find((s) => s === params.get('sort')) ?? 'created';
	const onboarding = params.get('onboarding') === 'complete' ? 'complete' : params.get('onboarding') === 'incomplete' ? 'incomplete' : '';
	return {
		q: (params.get('q') ?? '').trim().slice(0, 200),
		onboarding,
		sort,
		dir: params.get('dir') === 'asc' ? 'asc' : 'desc',
		page: parsePage(params.get('page')),
		pageSize: parsePageSize(params.get('pageSize'))
	};
}

const UUID_PREFIX = /^[0-9a-f-]{8,36}$/i;

export async function listAccounts(query: Required<AccountListQuery>) {
	const q = query.q;
	const like = likeContains(q);
	const exactId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q) ? q : null;
	const idPrefix = !exactId && UUID_PREFIX.test(q) ? q.toLowerCase() + '%' : null;
	const onb = query.onboarding === 'complete' ? true : query.onboarding === 'incomplete' ? false : null;

	const where = sql`
		WHERE (${onb}::boolean IS NULL OR a.onboarding_completed = ${onb})
		AND (${q === ''} OR a.name ILIKE ${like}
		     OR a.email ILIKE ${like}
		     OR a.sfdc_account_id ILIKE ${like}
		     OR ${exactId}::uuid = a.id
		     OR (${idPrefix}::text IS NOT NULL AND a.id::text LIKE ${idPrefix})
		     OR EXISTS (SELECT 1 FROM users u WHERE u.account_id = a.id AND u.email ILIKE ${like}))
	`;

	const dir = query.dir === 'asc' ? sql`ASC` : sql`DESC`;
	const orderBy =
		query.sort === 'name'
			? sql`ORDER BY lower(a.name) ${dir}, a.id`
			: query.sort === 'users'
				? sql`ORDER BY user_count ${dir}, a.id`
				: query.sort === 'stores'
					? sql`ORDER BY store_count ${dir}, a.id`
					: sql`ORDER BY a.created_at ${dir}, a.id`;

	const offset = (query.page - 1) * query.pageSize;
	const rows = await sql<AccountListRow[]>`
		SELECT a.id, a.name, a.email AS account_email,
		       o.email AS owner_email, o.display_name AS owner_name,
		       (SELECT count(*) FROM users u WHERE u.account_id = a.id)::int AS user_count,
		       (SELECT count(*) FROM stores s WHERE s.account_id = a.id)::int AS store_count,
		       a.onboarding_completed, a.sfdc_account_id, a.created_at
		FROM accounts a
		LEFT JOIN LATERAL (
			SELECT u.email, u.display_name FROM users u
			WHERE u.account_id = a.id AND u.role = 'owner'
			ORDER BY u.created_at, u.id LIMIT 1
		) o ON true
		${where}
		${orderBy}
		LIMIT ${query.pageSize} OFFSET ${offset}
	`;
	const [{ total }] = await sql<{ total: number }[]>`
		SELECT count(*)::int AS total FROM accounts a ${where}
	`;
	return { rows, total, page: query.page, pageSize: query.pageSize };
}

export interface AccountDetail {
	id: string;
	name: string;
	email: string | null;
	phone: string | null;
	website: string | null;
	billing_street: string | null;
	billing_city: string | null;
	billing_state: string | null;
	billing_postal_code: string | null;
	billing_country: string | null;
	onboarding_completed: boolean;
	sfdc_account_id: string | null;
	stripe_customer_id: string | null;
	created_at: Date;
	updated_at: Date;
	/** Opaque optimistic-lock token (microsecond-precision updated_at). */
	version: string;
}

export async function getAccount(accountId: string): Promise<AccountDetail | null> {
	const rows = await sql<AccountDetail[]>`
		SELECT id, name, email, phone, website, billing_street, billing_city, billing_state,
		       billing_postal_code, billing_country, onboarding_completed, sfdc_account_id,
		       stripe_customer_id, created_at, updated_at,
		       to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS version
		FROM accounts WHERE id = ${accountId}
	`;
	return rows[0] ?? null;
}

export async function accountSummary(accountId: string) {
	const [r] = await sql<
		{ users: number; active_users: number; stores: number; connected_stores: number; contracts: number; owner_email: string | null }[]
	>`
		SELECT
			(SELECT count(*) FROM users WHERE account_id = ${accountId})::int AS users,
			(SELECT count(*) FROM users WHERE account_id = ${accountId} AND is_active)::int AS active_users,
			(SELECT count(*) FROM stores WHERE account_id = ${accountId})::int AS stores,
			(SELECT count(*) FROM stores WHERE account_id = ${accountId} AND spapi_status = 'connected')::int AS connected_stores,
			(SELECT count(*) FROM service_contracts WHERE account_id = ${accountId})::int AS contracts,
			(SELECT email FROM users WHERE account_id = ${accountId} AND role = 'owner' ORDER BY created_at, id LIMIT 1) AS owner_email
	`;
	return r;
}

export interface AccountUserRow {
	id: string;
	email: string;
	display_name: string | null;
	role: string;
	is_active: boolean;
	must_reset_password: boolean;
	locked_until: Date | null;
	failed_login_attempts: number;
	last_login_at: Date | null;
	created_at: Date;
	is_staff: boolean;
}

export function listAccountUsers(accountId: string): Promise<AccountUserRow[]> {
	return sql<AccountUserRow[]>`
		SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.must_reset_password,
		       u.locked_until, u.failed_login_attempts, u.last_login_at, u.created_at,
		       (ps.user_id IS NOT NULL AND ps.is_active) AS is_staff
		FROM users u LEFT JOIN platform_staff ps ON ps.user_id = u.id
		WHERE u.account_id = ${accountId}
		ORDER BY u.created_at, u.id
	`;
}

/** A user, but only if they belong to this account (tamper-proof child lookup). */
export async function getAccountUser(accountId: string, userId: string): Promise<AccountUserRow | null> {
	const rows = await sql<AccountUserRow[]>`
		SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.must_reset_password,
		       u.locked_until, u.failed_login_attempts, u.last_login_at, u.created_at,
		       (ps.user_id IS NOT NULL AND ps.is_active) AS is_staff
		FROM users u LEFT JOIN platform_staff ps ON ps.user_id = u.id
		WHERE u.id = ${userId} AND u.account_id = ${accountId}
	`;
	return rows[0] ?? null;
}

export function listAccountStores(accountId: string) {
	return sql<
		{
			id: string; name: string; marketplaces: string | null; seller_id: string | null; country: string | null;
			store_email: string | null; sfdc_store_id: string | null; spapi_status: string;
			spapi_connected_at: Date | null; spapi_last_error: string | null; spapi_access_token_expires_at: Date | null;
			active_service_contract_id: string | null; poc_name: string | null; poc_email: string | null; created_at: Date;
		}[]
	>`
		SELECT s.id, s.name, s.marketplaces, s.seller_id, s.country, s.store_email, s.sfdc_store_id,
		       s.spapi_status, s.spapi_connected_at, s.spapi_last_error, s.spapi_access_token_expires_at,
		       s.active_service_contract_id,
		       NULLIF(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), '') AS poc_name,
		       c.email AS poc_email, s.created_at
		FROM stores s
		LEFT JOIN account_contacts c ON c.id = s.point_of_contact_id AND c.account_id = s.account_id
		WHERE s.account_id = ${accountId}
		ORDER BY s.created_at, s.id
	`;
}

export function listAccountContracts(accountId: string) {
	return sql<
		{
			id: string; kind: string | null; status: string | null; payment_status: string | null; store_id: string | null;
			store_name: string | null; amount_cents: string | null; currency: string | null; paid_at: Date | null;
			start_date: Date | null; end_date: Date | null; term_months: number | null; sync_status: string | null;
			sync_error: string | null; sfdc_service_contract_id: string | null; stripe_payment_intent_id: string | null;
			stripe_subscription_id: string | null; created_at: Date; line_items: number;
		}[]
	>`
		SELECT c.id, c.kind, c.status, c.payment_status, c.store_id, s.name AS store_name,
		       c.amount_cents::text AS amount_cents, c.currency, c.paid_at, c.start_date, c.end_date,
		       c.term_months, c.sync_status, c.sync_error, c.sfdc_service_contract_id,
		       c.stripe_payment_intent_id, c.stripe_subscription_id, c.created_at,
		       (SELECT count(*) FROM service_contract_line_items li WHERE li.service_contract_id = c.id)::int AS line_items
		FROM service_contracts c LEFT JOIN stores s ON s.id = c.store_id AND s.account_id = c.account_id
		WHERE c.account_id = ${accountId}
		ORDER BY c.created_at DESC, c.id
	`;
}

export function listAccountDocuments(accountId: string) {
	return sql<
		{
			kind: 'store' | 'case'; id: string; store_id: string; store_name: string; original_name: string;
			mime_type: string | null; size_bytes: string; sfdc_case_id: string | null; created_at: Date;
		}[]
	>`
		SELECT 'store' AS kind, d.id, d.store_id, s.name AS store_name, d.original_name, d.mime_type,
		       d.size_bytes::text AS size_bytes, NULL::text AS sfdc_case_id, d.created_at
		FROM store_documents d JOIN stores s ON s.id = d.store_id
		WHERE s.account_id = ${accountId}
		UNION ALL
		SELECT 'case', d.id, d.store_id, s.name, d.original_name, d.mime_type,
		       d.size_bytes::text, d.sfdc_case_id, d.created_at
		FROM case_documents d JOIN stores s ON s.id = d.store_id
		WHERE s.account_id = ${accountId}
		ORDER BY created_at DESC, id
		LIMIT 500
	`;
}

export function listAccountSyncState(accountId: string) {
	return sql<{ sfdc_object: string; status: string; n: number; last_error: string | null; last_at: Date }[]>`
		SELECT q.sfdc_object, q.status, count(*)::int AS n,
		       (array_agg(q.last_error ORDER BY q.created_at DESC) FILTER (WHERE q.last_error IS NOT NULL))[1] AS last_error,
		       max(q.created_at) AS last_at
		FROM sfdc_sync_queue q
		WHERE q.record_id IN (
			SELECT ${accountId}::text
			UNION SELECT sfdc_account_id FROM accounts WHERE id = ${accountId} AND sfdc_account_id IS NOT NULL
			UNION SELECT id::text FROM users WHERE account_id = ${accountId}
			UNION SELECT sfdc_contact_id FROM users WHERE account_id = ${accountId} AND sfdc_contact_id IS NOT NULL
			UNION SELECT id::text FROM stores WHERE account_id = ${accountId}
		)
		GROUP BY q.sfdc_object, q.status
		ORDER BY q.sfdc_object, q.status
	`;
}

export function listAccountSyncErrors(accountId: string) {
	return sql<{ id: string; at: Date; source: string; operation: string; message: string }[]>`
		SELECT id, created_at AS at, source, operation, left(error_message, 300) AS message
		FROM error_log
		WHERE account_id = ${accountId} AND (sfdc_object IS NOT NULL OR source ILIKE 'salesforce%' OR source ILIKE 'stripe%')
		ORDER BY created_at DESC, id DESC LIMIT 20
	`;
}

// ─── Global users ─────────────────────────────────────────────────────────

export interface GlobalUserRow {
	id: string;
	email: string;
	display_name: string | null;
	role: string;
	is_active: boolean;
	last_login_at: Date | null;
	created_at: Date;
	account_id: string | null;
	account_name: string | null;
	is_staff: boolean;
}

export async function listAllUsers(params: { q: string; page: number; pageSize: number; filter: '' | 'no_account' | 'inactive' | 'locked' }) {
	const like = likeContains(params.q);
	const where = sql`
		WHERE (${params.q === ''} OR u.email ILIKE ${like} OR u.display_name ILIKE ${like} OR a.name ILIKE ${like}
		       OR u.id::text = ${params.q})
		AND (${params.filter === ''}
		     OR (${params.filter === 'no_account'} AND u.account_id IS NULL)
		     OR (${params.filter === 'inactive'} AND NOT u.is_active)
		     OR (${params.filter === 'locked'} AND u.locked_until > now()))
	`;
	const offset = (params.page - 1) * params.pageSize;
	const rows = await sql<GlobalUserRow[]>`
		SELECT u.id, u.email, u.display_name, u.role, u.is_active, u.last_login_at, u.created_at,
		       u.account_id, a.name AS account_name,
		       (ps.user_id IS NOT NULL AND ps.is_active) AS is_staff
		FROM users u
		LEFT JOIN accounts a ON a.id = u.account_id
		LEFT JOIN platform_staff ps ON ps.user_id = u.id
		${where}
		ORDER BY u.created_at DESC, u.id
		LIMIT ${params.pageSize} OFFSET ${offset}
	`;
	const [{ total }] = await sql<{ total: number }[]>`
		SELECT count(*)::int AS total FROM users u LEFT JOIN accounts a ON a.id = u.account_id ${where}
	`;
	return { rows, total };
}
