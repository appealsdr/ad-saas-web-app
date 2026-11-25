-- 044_stripe_payment_records.sql
-- Keeps in the app everything about a payment executed through Stripe against a Salesforce Payment__c,
-- including payments on contracts that were created in Salesforce (contract first, or from an
-- Opportunity) and have no service_contracts row.
--
--   stripe_payments                  one row per successful PaymentIntent — written from Stripe's data,
--                                    so the money taken is on record even if Salesforce is unavailable.
--   salesforce_contracts             copy of a Salesforce-created ServiceContract that was paid here.
--   salesforce_contract_line_items   its ContractLineItems.
--   salesforce_contract_payments     its Payment__c records (paid and unpaid).
--
-- Salesforce stays the source of truth for the copies (refreshed on each payment); the app's pages keep
-- reading those contracts live. `data` holds the full Salesforce record.
-- These are separate from service_contracts on purpose: that table is for purchases the app made itself
-- (admin edit / sync-to-Salesforce / subscription logic act on it).

CREATE TABLE IF NOT EXISTS salesforce_contracts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id                    UUID REFERENCES stores(id) ON DELETE SET NULL,
  sfdc_service_contract_id    TEXT NOT NULL UNIQUE,
  sfdc_account_id             TEXT,
  sfdc_contact_id             TEXT,
  sfdc_store_id               TEXT,
  sfdc_pricebook2_id          TEXT,
  name                        TEXT,
  contract_number             TEXT,
  status                      TEXT,
  start_date                  DATE,
  end_date                    DATE,
  data                        JSONB NOT NULL,
  synced_at                   TIMESTAMPTZ NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_salesforce_contracts_account ON salesforce_contracts (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS salesforce_contract_line_items (
  sfdc_contract_line_item_id  TEXT PRIMARY KEY,
  salesforce_contract_id      UUID NOT NULL REFERENCES salesforce_contracts(id) ON DELETE CASCADE,
  product_name                TEXT,
  description                 TEXT,
  quantity                    NUMERIC(12, 2),
  unit_price                  NUMERIC(14, 2),
  data                        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sf_contract_lines_contract ON salesforce_contract_line_items (salesforce_contract_id);

CREATE TABLE IF NOT EXISTS salesforce_contract_payments (
  sfdc_payment_id             TEXT PRIMARY KEY,
  salesforce_contract_id      UUID NOT NULL REFERENCES salesforce_contracts(id) ON DELETE CASCADE,
  name                        TEXT,
  status                      TEXT,
  payment_type                TEXT,
  amount                      NUMERIC(14, 2),
  total_paid                  NUMERIC(14, 2),
  payment_date                DATE,
  paid_at                     TIMESTAMPTZ,
  sfdc_contract_line_item_id  TEXT,
  sfdc_opportunity_id         TEXT,
  stripe_payment_intent_id    TEXT,
  data                        JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sf_contract_payments_contract ON salesforce_contract_payments (salesforce_contract_id);

CREATE TABLE IF NOT EXISTS stripe_payments (
  stripe_payment_intent_id    TEXT PRIMARY KEY,
  account_id                  UUID REFERENCES accounts(id) ON DELETE CASCADE,  -- NULL: unknown account in Stripe metadata
  user_id                     UUID REFERENCES users(id) ON DELETE SET NULL,
  stripe_charge_id            TEXT,
  stripe_payment_method_id    TEXT,
  stripe_payment_method_type  TEXT,
  stripe_receipt_email        TEXT,
  stripe_receipt_url          TEXT,
  amount_cents                BIGINT NOT NULL,   -- the price
  fee_cents                   BIGINT NOT NULL DEFAULT 0, -- pass-through Stripe fee
  charged_cents               BIGINT NOT NULL,   -- what Stripe charged
  currency                    TEXT NOT NULL,
  paid_at                     TIMESTAMPTZ NOT NULL,
  sfdc_payment_id             TEXT NOT NULL,
  sfdc_payment_name           TEXT,
  sfdc_service_contract_id    TEXT,
  sfdc_contract_line_item_id  TEXT,
  service_contract_id         UUID REFERENCES service_contracts(id) ON DELETE SET NULL,
  salesforce_contract_id      UUID REFERENCES salesforce_contracts(id) ON DELETE SET NULL,
  -- Did the Salesforce Payment__c get updated? 'pending' | 'applied' | 'already_paid' | 'mismatch' | 'failed'
  sf_status                   TEXT NOT NULL DEFAULT 'pending',
  sf_error                    TEXT,
  contract_stored_at          TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stripe_payments_account ON stripe_payments (account_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_stripe_payments_sf_payment ON stripe_payments (sfdc_payment_id);
CREATE INDEX IF NOT EXISTS idx_stripe_payments_unapplied ON stripe_payments (sf_status) WHERE sf_status <> 'applied';

DROP TRIGGER IF EXISTS trg_stripe_payments_updated_at ON stripe_payments;
CREATE TRIGGER trg_stripe_payments_updated_at
  BEFORE UPDATE ON stripe_payments
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Admin reporting projections: no raw Salesforce JSON, free text or payment-method ids.
-- Re-run db/admin/provision_sql_reader.sql so the SQL reader role can read them.
CREATE OR REPLACE VIEW reporting.stripe_payments WITH (security_barrier = true) AS
  SELECT stripe_payment_intent_id, account_id, user_id, stripe_charge_id, stripe_payment_method_type,
         stripe_receipt_email, amount_cents, fee_cents, charged_cents, currency, paid_at,
         sfdc_payment_id, sfdc_payment_name, sfdc_service_contract_id, sfdc_contract_line_item_id,
         service_contract_id, salesforce_contract_id, sf_status, contract_stored_at, created_at, updated_at
  FROM public.stripe_payments;

CREATE OR REPLACE VIEW reporting.salesforce_contracts WITH (security_barrier = true) AS
  SELECT id, account_id, store_id, sfdc_service_contract_id, sfdc_account_id, sfdc_contact_id,
         sfdc_store_id, name, contract_number, status, start_date, end_date, synced_at, created_at
  FROM public.salesforce_contracts;

CREATE OR REPLACE VIEW reporting.salesforce_contract_line_items WITH (security_barrier = true) AS
  SELECT sfdc_contract_line_item_id, salesforce_contract_id, product_name, quantity, unit_price
  FROM public.salesforce_contract_line_items;

CREATE OR REPLACE VIEW reporting.salesforce_contract_payments WITH (security_barrier = true) AS
  SELECT sfdc_payment_id, salesforce_contract_id, name, status, payment_type, amount, total_paid,
         payment_date, paid_at, sfdc_contract_line_item_id, sfdc_opportunity_id, stripe_payment_intent_id
  FROM public.salesforce_contract_payments;
