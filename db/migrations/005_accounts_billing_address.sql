-- 005_accounts_billing_address.sql
-- Add billing address columns to accounts, mirroring Salesforce Account's
-- standard BillingAddress fields. Column names use snake_case (PG convention);
-- the app maps them to SF's PascalCase API names on read/write.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS billing_street      TEXT,
  ADD COLUMN IF NOT EXISTS billing_city        TEXT,
  ADD COLUMN IF NOT EXISTS billing_state       TEXT,
  ADD COLUMN IF NOT EXISTS billing_postal_code TEXT,
  ADD COLUMN IF NOT EXISTS billing_country     TEXT;
