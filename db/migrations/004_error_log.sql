-- 004_error_log.sql
-- Generic structured error sink. Salesforce sync failures are the first
-- caller (registration → Account/Contact create), but the schema is
-- domain-neutral so any subsystem can write to it.
--
-- Design notes:
--  - source + operation form a 2-level taxonomy ("salesforce.sync" /
--    "create_account"). Cheap to filter, cheap to add new ones.
--  - context is JSONB so the writer decides what extra structured data to
--    attach (e.g. the SF payload, the failed record id). DO NOT put
--    passwords, tokens, or PII secrets in here.
--  - FK ON DELETE SET NULL: deleting a user/account shouldn't wipe history.
--  - No created_at index by itself — both query patterns below use it as a
--    secondary sort column inside a composite index.

CREATE TABLE IF NOT EXISTS error_log (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source         TEXT NOT NULL,             -- 'salesforce.sync' | 'register' | 'auth.session' | ...
  operation      TEXT NOT NULL,             -- 'create_account' | 'create_contact' | 'persist_ids' | ...
  severity       TEXT NOT NULL DEFAULT 'error',  -- 'error' | 'warn'
  user_id        UUID REFERENCES users(id) ON DELETE SET NULL,
  account_id     UUID REFERENCES accounts(id) ON DELETE SET NULL,
  sfdc_object    TEXT,                      -- 'Account' | 'Contact' | NULL for non-SF errors
  error_code     TEXT,                      -- 'INVALID_FIELD' | 'DUPLICATE_VALUE' | HTTP status, etc.
  error_message  TEXT NOT NULL,
  context        JSONB,                     -- arbitrary extra context (no secrets)
  stack          TEXT
);

-- Recent-errors tail (Ops/UI)
CREATE INDEX IF NOT EXISTS idx_error_log_created
  ON error_log (created_at DESC);

-- Filter by subsystem, newest first
CREATE INDEX IF NOT EXISTS idx_error_log_source_created
  ON error_log (source, created_at DESC);

-- "What went wrong for THIS user/account?"
CREATE INDEX IF NOT EXISTS idx_error_log_user
  ON error_log (user_id, created_at DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_log_account
  ON error_log (account_id, created_at DESC) WHERE account_id IS NOT NULL;
