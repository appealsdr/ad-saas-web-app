-- 011_service_contracts.sql
-- Local mirror of every Stripe purchase that became a Salesforce ServiceContract.
-- One row per Stripe PaymentIntent. The line-items table mirrors what we
-- pushed to ContractLineItem records (so the invoice screen works even when
-- SF is down / not configured yet).
--
-- Idempotency: stripe_payment_intent_id is UNIQUE — multiple loads of
-- /checkout/success can't double-create the contract.

CREATE TABLE IF NOT EXISTS service_contracts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id                     UUID REFERENCES users(id) ON DELETE SET NULL,
  store_id                    UUID REFERENCES stores(id) ON DELETE SET NULL,

  -- Stripe ─────────────────────────────────────────────────────
  stripe_payment_intent_id    TEXT UNIQUE NOT NULL,
  stripe_charge_id            TEXT,
  stripe_payment_method_id    TEXT,
  stripe_payment_method_type  TEXT,
  stripe_receipt_email        TEXT,
  amount_cents                BIGINT NOT NULL,
  currency                    TEXT NOT NULL,
  paid_at                     TIMESTAMPTZ NOT NULL,

  -- Contract terms ─────────────────────────────────────────────
  start_date                  DATE NOT NULL,
  end_date                    DATE NOT NULL,
  term_months                 INT NOT NULL DEFAULT 3,

  -- Salesforce mirror ──────────────────────────────────────────
  sfdc_service_contract_id    TEXT UNIQUE,
  sfdc_account_id             TEXT,
  sfdc_contact_id             TEXT,
  sfdc_store_id               TEXT,
  sfdc_pricebook2_id          TEXT,

  -- Sync state ─────────────────────────────────────────────────
  sync_status                 TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'synced' | 'failed'
  sync_error                  TEXT,
  synced_at                   TIMESTAMPTZ,

  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_contracts_account
  ON service_contracts (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_service_contracts_store
  ON service_contracts (store_id) WHERE store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_service_contracts_sync_status
  ON service_contracts (sync_status) WHERE sync_status <> 'synced';

DROP TRIGGER IF EXISTS trg_service_contracts_updated_at ON service_contracts;
CREATE TRIGGER trg_service_contracts_updated_at
  BEFORE UPDATE ON service_contracts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────
-- One row per line item (what was actually purchased).
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS service_contract_line_items (
  id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_contract_id             UUID NOT NULL REFERENCES service_contracts(id) ON DELETE CASCADE,

  product_name                    TEXT NOT NULL,
  product_description             TEXT,
  product_category                TEXT,
  sfdc_product_id                 TEXT,
  sfdc_pricebook_entry_id         TEXT,

  unit_price                      NUMERIC(12, 2) NOT NULL,
  quantity                        INT NOT NULL DEFAULT 1,
  currency                        TEXT NOT NULL,

  -- Salesforce mirror
  sfdc_contract_line_item_id      TEXT,

  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contract_line_items_contract
  ON service_contract_line_items (service_contract_id);
