-- 025_account_subscriptions.sql
-- Subscriptions are ACCOUNT-level: one active plan covers every store in the
-- account. accounts.active_subscription_contract_id points at the account's
-- current active 'subscription' service_contract (stores.active_service_contract_id
-- keeps tracking one-off service purchases only).
--
-- Backfill: each account with at least one active store-level subscription gets
-- its most recently paid active subscription. Any OTHER active subscription
-- contracts for the same account are left untouched (history / possibly still
-- billing in Stripe) — review them with:
--   SELECT account_id, count(*) FROM service_contracts
--   WHERE kind='subscription' AND status='active' GROUP BY 1 HAVING count(*) > 1;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS active_subscription_contract_id
    UUID REFERENCES service_contracts(id) ON DELETE SET NULL;

UPDATE accounts a
SET active_subscription_contract_id = x.id
FROM (
  SELECT DISTINCT ON (account_id) id, account_id
  FROM service_contracts
  WHERE kind = 'subscription' AND status = 'active'
  ORDER BY account_id, paid_at DESC
) x
WHERE a.id = x.account_id AND a.active_subscription_contract_id IS NULL;

-- Expose the new (non-sensitive) column in the admin reporting view. CREATE OR
-- REPLACE VIEW may only append columns, so it goes last; existing grants are kept.
CREATE OR REPLACE VIEW reporting.accounts WITH (security_barrier = true) AS
  SELECT id, name, email, phone, website, sfdc_account_id, stripe_customer_id,
         billing_street, billing_city, billing_state, billing_postal_code, billing_country,
         onboarding_completed, created_at, updated_at, active_subscription_contract_id
  FROM public.accounts;
