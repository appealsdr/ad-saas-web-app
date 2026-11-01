-- 024_admin_reporting_views.sql
-- Reviewed, secret-free projections for the platform admin data explorer and
-- the read-only SQL reader role (see db/admin/provision_sql_reader.sql).
--
-- Rules for this schema:
--   * Only columns reviewed as safe are listed. Never `SELECT *`.
--   * Secret columns (password hashes, tokens, API-key hashes, TOTP secrets,
--     OAuth/SP-API tokens, invite tokens) are NOT projected.
--   * Raw log text/JSON (error_log.error_message/context/stack,
--     activity_log.event_data, sfdc payloads) is NOT projected; the admin app
--     serves logs through its redacting log viewer instead.
--   * Views run with the privileges of their owner (the migration role) and
--     are security_barrier. The schema has no row-level security today; if RLS
--     is ever added, FORCE it or use security_invoker views.
--   * New tables are metadata-only until added here AND to
--     src/lib/server/admin/data/inventory.ts.

CREATE SCHEMA IF NOT EXISTS reporting;
REVOKE ALL ON SCHEMA reporting FROM PUBLIC;

CREATE OR REPLACE VIEW reporting.accounts WITH (security_barrier = true) AS
  SELECT id, name, email, phone, website, sfdc_account_id, stripe_customer_id,
         billing_street, billing_city, billing_state, billing_postal_code, billing_country,
         onboarding_completed, created_at, updated_at
  FROM public.accounts;

CREATE OR REPLACE VIEW reporting.users WITH (security_barrier = true) AS
  SELECT id, email, display_name, account_id, role, is_active, must_reset_password,
         failed_login_attempts, locked_until, last_login_at,
         sfdc_contact_id, sfdc_account_id, created_at, updated_at
  FROM public.users;

CREATE OR REPLACE VIEW reporting.account_contacts WITH (security_barrier = true) AS
  SELECT id, account_id, user_id, first_name, last_name, email, phone, title,
         is_point_of_contact, sfdc_contact_id, invite_sent_at, invite_accepted_at,
         created_by, created_at, updated_at
  FROM public.account_contacts;

CREATE OR REPLACE VIEW reporting.stores WITH (security_barrier = true) AS
  SELECT id, account_id, created_by, name, marketplaces, seller_id, seller_primary_email,
         store_email, business_name, country, description, sfdc_store_id,
         spapi_status, spapi_access_token_expires_at, spapi_connected_seller_id,
         spapi_connected_at, spapi_last_error, point_of_contact_id,
         active_service_contract_id, created_at, updated_at
  FROM public.stores;

CREATE OR REPLACE VIEW reporting.store_documents WITH (security_barrier = true) AS
  SELECT id, store_id, uploaded_by, original_name, mime_type, size_bytes,
         sfdc_case_file_id, created_at
  FROM public.store_documents;

CREATE OR REPLACE VIEW reporting.case_documents WITH (security_barrier = true) AS
  SELECT id, store_id, sfdc_case_id, uploaded_by, original_name, mime_type, size_bytes,
         sfdc_case_file_id, created_at
  FROM public.case_documents;

CREATE OR REPLACE VIEW reporting.service_contracts WITH (security_barrier = true) AS
  SELECT id, account_id, user_id, store_id, kind, status, payment_status,
         stripe_payment_intent_id, stripe_charge_id, stripe_subscription_id,
         stripe_payment_method_type, stripe_receipt_email,
         amount_cents, currency, paid_at, start_date, end_date, term_months,
         sfdc_service_contract_id, sfdc_account_id, sfdc_contact_id, sfdc_store_id,
         sync_status, sync_error, synced_at, created_at, updated_at
  FROM public.service_contracts;

CREATE OR REPLACE VIEW reporting.service_contract_line_items WITH (security_barrier = true) AS
  SELECT id, service_contract_id, product_name, product_category, unit_price, quantity,
         currency, sfdc_product_id, sfdc_contract_line_item_id, created_at
  FROM public.service_contract_line_items;

CREATE OR REPLACE VIEW reporting.ai_chat_messages WITH (security_barrier = true) AS
  SELECT id, account_id, store_id, user_id, conversation_id, provider, model, status,
         length(question) AS question_length, length(answer) AS answer_length,
         created_at, answered_at
  FROM public.ai_chat_messages;

CREATE OR REPLACE VIEW reporting.stripe_webhook_events WITH (security_barrier = true) AS
  SELECT stripe_event_id, event_type, processed_at
  FROM public.stripe_webhook_events;

-- Security-related tables: IDs, timestamps and non-secret metadata only.
CREATE OR REPLACE VIEW reporting.sessions WITH (security_barrier = true) AS
  SELECT id, user_id, created_at, expires_at FROM public.sessions;

CREATE OR REPLACE VIEW reporting.password_reset_tokens WITH (security_barrier = true) AS
  SELECT id, user_id, expires_at, used_at, created_at FROM public.password_reset_tokens;

CREATE OR REPLACE VIEW reporting.password_history WITH (security_barrier = true) AS
  SELECT id, user_id, created_at FROM public.password_history;

CREATE OR REPLACE VIEW reporting.oauth_accounts WITH (security_barrier = true) AS
  SELECT id, user_id, provider, expires_at FROM public.oauth_accounts;

CREATE OR REPLACE VIEW reporting.api_keys WITH (security_barrier = true) AS
  SELECT id, label, scopes, last_used_at, expires_at, revoked_at, created_at
  FROM public.api_keys;

CREATE OR REPLACE VIEW reporting.spapi_oauth_states WITH (security_barrier = true) AS
  SELECT store_id, user_id, created_at, expires_at FROM public.spapi_oauth_states;

-- Salesforce plumbing: payload/data JSON omitted.
CREATE OR REPLACE VIEW reporting.sfdc_sync_queue WITH (security_barrier = true) AS
  SELECT id, operation, sfdc_object, record_id, status, attempts, created_at, processed_at
  FROM public.sfdc_sync_queue;

CREATE OR REPLACE VIEW reporting.sfdc_records WITH (security_barrier = true) AS
  SELECT sfdc_id, object_type, synced_at FROM public.sfdc_records;

-- Logs: metadata only (no message/context/stack/event_data).
CREATE OR REPLACE VIEW reporting.error_log WITH (security_barrier = true) AS
  SELECT id, created_at, source, operation, severity, user_id, account_id,
         sfdc_object, error_code, request_id
  FROM public.error_log;

CREATE OR REPLACE VIEW reporting.activity_log WITH (security_barrier = true) AS
  SELECT id, user_id, session_id, account_id, event_type, request_id, created_at
  FROM public.activity_log;

-- Platform admin tables.
CREATE OR REPLACE VIEW reporting.platform_staff WITH (security_barrier = true) AS
  SELECT id, user_id, role, is_active, granted_by, created_at, updated_at, deactivated_at
  FROM public.platform_staff;

CREATE OR REPLACE VIEW reporting.admin_sessions WITH (security_barrier = true) AS
  SELECT id, user_id, mfa_verified_at, last_activity_at, expires_at, created_at,
         revoked_at, revoked_reason
  FROM public.admin_sessions;

CREATE OR REPLACE VIEW reporting.admin_mfa_credentials WITH (security_barrier = true) AS
  SELECT user_id, confirmed_at, created_at FROM public.admin_mfa_credentials;

CREATE OR REPLACE VIEW reporting.admin_recovery_codes WITH (security_barrier = true) AS
  SELECT id, user_id, used_at, created_at FROM public.admin_recovery_codes;

CREATE OR REPLACE VIEW reporting.admin_audit_events WITH (security_barrier = true) AS
  SELECT id, occurred_at, actor_user_id, actor_ref, actor_role, action, target_type,
         target_id, target_account_id, outcome, request_id
  FROM public.admin_audit_events;
