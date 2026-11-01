-- 022_stripe_webhook_events.sql
-- Idempotency guard for Stripe webhook processing. Stripe can and will
-- redeliver the same event (retries on timeout, manual resend from the
-- dashboard, etc.) — inserting the event id first and skipping on conflict
-- keeps us from creating a duplicate Payment__c per redelivered
-- invoice.payment_succeeded event.

CREATE TABLE IF NOT EXISTS stripe_webhook_events (
  stripe_event_id  TEXT PRIMARY KEY,
  event_type       TEXT NOT NULL,
  processed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
