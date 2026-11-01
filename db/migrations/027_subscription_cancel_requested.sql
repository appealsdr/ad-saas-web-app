-- 027_subscription_cancel_requested.sql
-- When a customer cancels a Stripe subscription from the Billing Portal it normally stays
-- active until the end of the paid period. We keep the contract active, set its end_date to the
-- Stripe period end, and remember WHEN cancellation was requested so the app can say
-- "Ends <date>" instead of "Renews <date>". Resuming the subscription clears it.
ALTER TABLE service_contracts ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

-- Expose it in the admin reporting projection (views may only gain columns at the end).
CREATE OR REPLACE VIEW reporting.service_contracts WITH (security_barrier = true) AS
  SELECT id, account_id, user_id, store_id, kind, status, payment_status,
         stripe_payment_intent_id, stripe_charge_id, stripe_subscription_id,
         stripe_payment_method_type, stripe_receipt_email,
         amount_cents, currency, paid_at, start_date, end_date, term_months,
         sfdc_service_contract_id, sfdc_account_id, sfdc_contact_id, sfdc_store_id,
         sync_status, sync_error, synced_at, created_at, updated_at, cancel_requested_at
  FROM public.service_contracts;
