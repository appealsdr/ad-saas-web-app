-- 006_stores.sql
-- Local store records (mirror of Salesforce Store__c) + LWA/SP-API connection
-- state + uploaded documents.
--
-- spapi_status timeline:
--   'disconnected' → user just created the store, never linked Amazon
--   'connected'    → OAuth completed, refresh_token stored
--   'error'        → last refresh attempt failed; details in spapi_last_error

CREATE TABLE IF NOT EXISTS stores (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by                    UUID REFERENCES users(id) ON DELETE SET NULL,

  -- ── Mapped to Salesforce Store__c ────────────────────────────
  name                          TEXT NOT NULL,                -- Name
  marketplaces                  TEXT,                          -- Marketplaces__c (multi-picklist; we store ';'-joined)
  seller_id                     TEXT,                          -- Seller_ID__c
  seller_primary_email          TEXT,                          -- Seller_Account_Primary_Email__c (Amazon notifications)
  store_email                   TEXT,                          -- Store_Email__c
  business_name                 TEXT,                          -- Business_Name__c
  country                       TEXT,                          -- Country__c
  description                   TEXT,                          -- Description__c

  -- ── Salesforce link ──────────────────────────────────────────
  sfdc_store_id                 TEXT UNIQUE,                   -- Salesforce Store__c Id

  -- ── SP-API / LWA OAuth state ─────────────────────────────────
  spapi_status                  TEXT NOT NULL DEFAULT 'disconnected',
  spapi_refresh_token           TEXT,                          -- long-lived; encrypt at rest in prod
  spapi_access_token            TEXT,                          -- short-lived; lazy-refreshed
  spapi_access_token_expires_at TIMESTAMPTZ,
  spapi_connected_seller_id     TEXT,                          -- from selling_partner_id in callback
  spapi_connected_at            TIMESTAMPTZ,
  spapi_last_error              TEXT,

  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stores_account     ON stores (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stores_seller_id   ON stores (seller_id) WHERE seller_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stores_sfdc_id     ON stores (sfdc_store_id) WHERE sfdc_store_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stores_status      ON stores (spapi_status);

DROP TRIGGER IF EXISTS trg_stores_updated_at ON stores;
CREATE TRIGGER trg_stores_updated_at
  BEFORE UPDATE ON stores
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ─────────────────────────────────────────────────────────────────
-- spapi_oauth_states — ephemeral CSRF state for the OAuth handoff.
-- Each row maps a random opaque token (sent to Amazon via ?state=)
-- back to the store the user was connecting. Rows expire after ~10 min.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS spapi_oauth_states (
  state       TEXT PRIMARY KEY,
  store_id    UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_states_expires ON spapi_oauth_states (expires_at);

-- ─────────────────────────────────────────────────────────────────
-- store_documents — file uploads per store. File bytes live on disk
-- (./uploads/stores/<store_id>/<file_id>-<filename>) for dev; swap to
-- S3 for prod by adding an s3_key column and switching the writer.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS store_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  original_name   TEXT NOT NULL,
  storage_path    TEXT NOT NULL,                 -- relative to ./uploads/ (or future s3 key)
  mime_type       TEXT,
  size_bytes      BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_store_documents_store
  ON store_documents (store_id, created_at DESC);
