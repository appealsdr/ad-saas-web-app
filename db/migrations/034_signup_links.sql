-- 034_signup_links.sql
-- Single-use tracking for Salesforce-issued sign-up links (AD-1934).
-- Salesforce sends the client an HMAC-signed link carrying the existing
-- Account / Contact / ServiceContract Ids. Registering through it links the
-- new app account to those records instead of creating new ones.
CREATE TABLE IF NOT EXISTS signup_links (
  nonce                     TEXT PRIMARY KEY,
  sfdc_account_id           TEXT NOT NULL,
  sfdc_contact_id           TEXT NOT NULL,
  sfdc_service_contract_id  TEXT,
  account_id                UUID REFERENCES accounts(id) ON DELETE SET NULL,
  user_id                   UUID REFERENCES users(id) ON DELETE SET NULL,
  used_at                   TIMESTAMPTZ NOT NULL DEFAULT now()
);
