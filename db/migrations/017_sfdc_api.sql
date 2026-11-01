-- 017_sfdc_api.sql
-- Support for the Salesforce-facing provisioning/reset API:
--   - users.must_reset_password: sends a freshly-provisioned or reset user
--     through the forced password-change flow on their next login instead of
--     straight into a session.
--   - api_keys: bearer tokens for server-to-server callers (Salesforce). Only
--     the SHA-256 hash is stored, mirroring sessions.token_hash.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS api_keys (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label         TEXT NOT NULL,               -- e.g. "Salesforce - provisioning"
  key_hash      TEXT UNIQUE NOT NULL,        -- SHA-256 of the raw key (hex)
  scopes        TEXT[] NOT NULL DEFAULT '{}', -- e.g. {provision, reset_password}
  last_used_at  TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ,                 -- NULL = no expiry
  revoked_at    TIMESTAMPTZ,                 -- NULL = active
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys (key_hash);
