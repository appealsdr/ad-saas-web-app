-- 029_balance_payment_applications.sql
-- A deposit balance is paid by completing Stripe against the EXISTING Salesforce Payment__c.
-- The success page and the payment_intent.succeeded webhook can both fire (and Stripe retries
-- webhooks), so the first one to claim a PaymentIntent here applies the payment; the others do nothing.
CREATE TABLE IF NOT EXISTS balance_payment_applications (
  stripe_payment_intent_id TEXT PRIMARY KEY,
  sfdc_payment_id          TEXT NOT NULL,
  applied_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
