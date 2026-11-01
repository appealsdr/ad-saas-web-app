/**
 * Inventory of EVERY application table and how the admin data explorer may
 * expose it. Each entry maps to a reviewed projection in the `reporting`
 * schema (db/migrations/024_admin_reporting_views.sql) or is metadata-only.
 *
 * A table in `public` that is missing here is shown as "unreviewed —
 * metadata only" and is never readable; add it here + a reporting view after
 * review. tests/admin/inventory.test.ts fails if this drifts from the schema.
 */
import { sql } from '../../db';

export type AccountScopeFn = (accountId: string) => ReturnType<typeof sql>;

export interface TableEntry {
	name: string;
	/** Name of the reporting view (same as table) or null when metadata-only. */
	view: string | null;
	/** Why the table is restricted / what is hidden, shown in the UI. */
	note: string;
	/** Columns deliberately NOT projected. */
	hidden: string[];
	/** How rows relate to ONE account (documented FK mapping). Absent → global/unrelated. */
	accountScope?: AccountScopeFn;
	accountScopeNote?: string;
}

const own = (col: string): AccountScopeFn => (id) => sql`${sql(col)} = ${id}`;
const viaStores: AccountScopeFn = (id) => sql`store_id IN (SELECT id FROM reporting.stores WHERE account_id = ${id})`;
const viaUsers = (col = 'user_id'): AccountScopeFn => (id) =>
	sql`${sql(col)} IN (SELECT id FROM reporting.users WHERE account_id = ${id})`;

export const INVENTORY: TableEntry[] = [
	{ name: 'accounts', view: 'accounts', note: 'Customer accounts.', hidden: [], accountScope: own('id'), accountScopeNote: 'accounts.id = account' },
	{ name: 'users', view: 'users', note: 'Customer users. Password hash omitted.', hidden: ['password_hash', 'avatar_url'], accountScope: own('account_id'), accountScopeNote: 'users.account_id = account' },
	{ name: 'account_contacts', view: 'account_contacts', note: 'Account contacts. Invite tokens omitted.', hidden: ['invite_token'], accountScope: own('account_id'), accountScopeNote: 'account_contacts.account_id = account' },
	{ name: 'stores', view: 'stores', note: 'Stores. SP-API tokens and OAuth callback params omitted.', hidden: ['spapi_refresh_token', 'spapi_access_token', 'spapi_callback_params'], accountScope: own('account_id'), accountScopeNote: 'stores.account_id = account' },
	{ name: 'store_documents', view: 'store_documents', note: 'Store document metadata. Storage paths omitted.', hidden: ['storage_path', 's3_bucket', 's3_key'], accountScope: viaStores, accountScopeNote: 'store_documents.store_id → stores.account_id' },
	{ name: 'case_documents', view: 'case_documents', note: 'Case document metadata. Storage keys omitted.', hidden: ['s3_bucket', 's3_key'], accountScope: viaStores, accountScopeNote: 'case_documents.store_id → stores.account_id' },
	{ name: 'service_contracts', view: 'service_contracts', note: 'Service contracts, payments and subscriptions.', hidden: ['stripe_payment_method_id', 'sfdc_pricebook2_id'], accountScope: own('account_id'), accountScopeNote: 'service_contracts.account_id = account' },
	{ name: 'service_contract_line_items', view: 'service_contract_line_items', note: 'Contract line items.', hidden: ['product_description', 'sfdc_pricebook_entry_id'], accountScope: (id) => sql`service_contract_id IN (SELECT id FROM reporting.service_contracts WHERE account_id = ${id})`, accountScopeNote: 'line_items.service_contract_id → service_contracts.account_id' },
	{ name: 'ai_chat_messages', view: 'ai_chat_messages', note: 'AI assistant messages. Question/answer text omitted (lengths only).', hidden: ['question', 'answer', 'error_message'], accountScope: own('account_id'), accountScopeNote: 'ai_chat_messages.account_id = account' },
	{ name: 'stripe_webhook_events', view: 'stripe_webhook_events', note: 'Processed Stripe webhook event ids (global).', hidden: [] },
	{ name: 'sessions', view: 'sessions', note: 'Customer sessions: ids and timestamps only (no token hash, IP or user agent).', hidden: ['token_hash', 'ip_address', 'user_agent', 'read_only', 'impersonated_by'], accountScope: viaUsers(), accountScopeNote: 'sessions.user_id → users.account_id' },
	{ name: 'password_reset_tokens', view: 'password_reset_tokens', note: 'Reset tokens: ids and timestamps only.', hidden: ['token_hash', 'email'], accountScope: viaUsers(), accountScopeNote: 'password_reset_tokens.user_id → users.account_id' },
	{ name: 'password_history', view: 'password_history', note: 'Password history: ids and timestamps only.', hidden: ['password_hash'], accountScope: viaUsers(), accountScopeNote: 'password_history.user_id → users.account_id' },
	{ name: 'oauth_accounts', view: 'oauth_accounts', note: 'Linked identity providers. Tokens and provider ids omitted.', hidden: ['provider_uid', 'access_token', 'refresh_token'], accountScope: viaUsers(), accountScopeNote: 'oauth_accounts.user_id → users.account_id' },
	{ name: 'api_keys', view: 'api_keys', note: 'Salesforce API keys: label/scopes/timestamps only (global).', hidden: ['key_hash'] },
	{ name: 'spapi_oauth_states', view: 'spapi_oauth_states', note: 'SP-API OAuth handshakes. The state value is omitted.', hidden: ['state'], accountScope: viaStores, accountScopeNote: 'spapi_oauth_states.store_id → stores.account_id' },
	{ name: 'sfdc_sync_queue', view: 'sfdc_sync_queue', note: 'Salesforce sync queue (global). Payload JSON omitted.', hidden: ['payload', 'last_error'] },
	{ name: 'sfdc_records', view: 'sfdc_records', note: 'Cached Salesforce records (global). Data JSON omitted.', hidden: ['data'] },
	{ name: 'error_log', view: 'error_log', note: 'Metadata only here. Read messages/context/stack in the redacting Logs viewer.', hidden: ['error_message', 'context', 'stack'], accountScope: own('account_id'), accountScopeNote: 'error_log.account_id = account (historical rows may be unattributed)' },
	{ name: 'activity_log', view: 'activity_log', note: 'Metadata only here. Event data and IPs omitted; use the Logs viewer.', hidden: ['event_data', 'ip_address'], accountScope: own('account_id'), accountScopeNote: 'activity_log.account_id = account (historical rows are unattributed)' },
	{ name: 'platform_staff', view: 'platform_staff', note: 'Platform admin identities and roles (global). Password hash omitted.', hidden: ['granted_by_ref', 'password_hash'] },
	{ name: 'admin_sessions', view: 'admin_sessions', note: 'Admin sessions: ids and timestamps only.', hidden: ['token_hash', 'ip_address', 'user_agent', 'revoked_by'] },
	{ name: 'admin_mfa_credentials', view: 'admin_mfa_credentials', note: 'MFA enrollment state only. Secrets are never readable.', hidden: ['secret_encrypted', 'last_used_step'] },
	{ name: 'admin_recovery_codes', view: 'admin_recovery_codes', note: 'Recovery code status only. Hashes are never readable.', hidden: ['code_hash'] },
	{ name: 'admin_audit_events', view: 'admin_audit_events', note: 'Audit trail summary (append-only). Details/IP/reason are in the Logs viewer (redacted).', hidden: ['reason', 'ip_address', 'metadata'], accountScope: (id) => sql`target_account_id = ${id}`, accountScopeNote: 'admin_audit_events.target_account_id = account' },
	{ name: 'balance_payment_applications', view: null, note: 'Idempotency ledger for deposit balance payments (PaymentIntent → Payment__c). Metadata only.', hidden: [] },
	{ name: 'admin_login_challenges', view: null, note: 'Metadata only: every column is security state (token hash, attempts, next path).', hidden: ['*'] },
	{ name: 'admin_rate_limits', view: null, note: 'Metadata only: rate-limit keys embed emails and IP addresses.', hidden: ['*'] },
	{ name: 'admin_sql_active', view: null, note: 'Metadata only: operational lock table for the SQL runner.', hidden: ['*'] }
];

export const INVENTORY_BY_NAME = new Map(INVENTORY.map((e) => [e.name, e]));

/** Views the SQL runner may reference (everything with a projection). */
export const REPORTING_VIEWS: ReadonlySet<string> = new Set(INVENTORY.filter((e) => e.view).map((e) => e.view as string));

export function unreviewedEntry(name: string): TableEntry {
	return {
		name,
		view: null,
		note: 'Not yet reviewed — metadata only. Add an entry to inventory.ts and a reporting view to expose it.',
		hidden: ['*']
	};
}
