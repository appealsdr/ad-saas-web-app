-- 021_stripe_billing.sql
-- Real Stripe Customer objects (one per local account, reused across every
-- purchase) + recurring Stripe Subscriptions for the 'subscription' kind of
-- service_contracts, plus a local mirror of Salesforce's Payment_Status__c
-- so the app can render status without round-tripping to Salesforce.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT UNIQUE;

ALTER TABLE service_contracts
  ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'Paid';
  -- 'Paid' (one-off service) | 'Subscription' (active recurring plan) | 'Canceled'

CREATE INDEX IF NOT EXISTS idx_service_contracts_stripe_subscription
  ON service_contracts (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
