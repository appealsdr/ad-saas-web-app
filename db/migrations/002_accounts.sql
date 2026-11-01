-- 002_accounts.sql
-- Introduces customer Accounts (mirrors Salesforce Account / Contact model)
-- and links users to them. A user belongs to exactly one account; an account
-- can have many users.

CREATE TABLE IF NOT EXISTS accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,
  email            TEXT,
  phone            TEXT,
  sfdc_account_id  TEXT UNIQUE,                -- backfilled after SF sync
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_accounts_email
  ON accounts (email) WHERE email IS NOT NULL;

-- Reuse the updated_at trigger function created in 001_init.sql
DROP TRIGGER IF EXISTS trg_accounts_updated_at ON accounts;
CREATE TRIGGER trg_accounts_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- Link users to their account. ON DELETE SET NULL so we don't cascade-delete
-- users when an account is removed — operationally safer.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_account_id
  ON users (account_id) WHERE account_id IS NOT NULL;
