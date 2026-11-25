-- 045_stripe_payment_import.sql
-- stripe_payments now holds any Stripe transaction an admin imports (a first purchase, a subscription renewal,
-- another charge), not only payments on an existing Salesforce payment record.
ALTER TABLE stripe_payments ALTER COLUMN sfdc_payment_id DROP NOT NULL;

ALTER TABLE stripe_payments
  ADD COLUMN IF NOT EXISTS kind                    TEXT NOT NULL DEFAULT 'balance', -- 'balance' | 'checkout' | 'subscription' | 'renewal' | 'other'
  ADD COLUMN IF NOT EXISTS stripe_invoice_id       TEXT,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id  TEXT,
  ADD COLUMN IF NOT EXISTS imported_at             TIMESTAMPTZ; -- set when staff imported it from Stripe

-- Views may only gain columns at the end.
CREATE OR REPLACE VIEW reporting.stripe_payments WITH (security_barrier = true) AS
  SELECT stripe_payment_intent_id, account_id, user_id, stripe_charge_id, stripe_payment_method_type,
         stripe_receipt_email, amount_cents, fee_cents, charged_cents, currency, paid_at,
         sfdc_payment_id, sfdc_payment_name, sfdc_service_contract_id, sfdc_contract_line_item_id,
         service_contract_id, salesforce_contract_id, sf_status, contract_stored_at, created_at, updated_at,
         kind, stripe_invoice_id, stripe_subscription_id, imported_at
  FROM public.stripe_payments;
