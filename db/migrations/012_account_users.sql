-- 012_account_users.sql
-- Multi-user accounts: roles, contact management, and point-of-contact support.

-- Add role column to users table
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('owner', 'admin', 'member'));

-- account_contacts: additional contacts/users invited to an account.
-- A contact may or may not have a corresponding users row (they may be
-- invited but not yet registered, or be external contacts without login access).
CREATE TABLE IF NOT EXISTS account_contacts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id          UUID REFERENCES users(id) ON DELETE SET NULL, -- null until they register
  first_name       TEXT,
  last_name        TEXT NOT NULL,
  email            TEXT NOT NULL,
  phone            TEXT,
  title            TEXT,                      -- job title / role label
  is_point_of_contact BOOLEAN NOT NULL DEFAULT false,
  sfdc_contact_id  TEXT,                      -- linked Salesforce Contact
  invite_token     TEXT UNIQUE,               -- pending invitation token (bcrypt-hashed)
  invite_sent_at   TIMESTAMPTZ,
  invite_accepted_at TIMESTAMPTZ,
  created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_id, email)
);

CREATE INDEX IF NOT EXISTS idx_account_contacts_account_id
  ON account_contacts (account_id);
CREATE INDEX IF NOT EXISTS idx_account_contacts_user_id
  ON account_contacts (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_account_contacts_poc
  ON account_contacts (account_id) WHERE is_point_of_contact = true;

-- Only one point-of-contact per account at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_account_contacts_one_poc
  ON account_contacts (account_id) WHERE is_point_of_contact = true;

DROP TRIGGER IF EXISTS trg_account_contacts_updated_at ON account_contacts;
CREATE TRIGGER trg_account_contacts_updated_at
  BEFORE UPDATE ON account_contacts
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
