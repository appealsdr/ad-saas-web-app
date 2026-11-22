-- 039_api_integrations.sql (AD-1966)
-- Multi-integration public API. One account can have many independent API
-- integrations; each has its own credentials, permission profile, default user,
-- status, IP allowlist, rate limit, idempotency namespace and audit trail.
-- Separate from api_keys (Salesforce provisioning keys), which are unchanged.

-- NOTE: the acting-admin columns (created_by/updated_by/paused_by/disabled_by/revoked_by) reference
-- platform_staff(user_id), not users(id): since migration 030 platform admins are standalone identities.
CREATE TABLE IF NOT EXISTS integration_clients (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,

  name                   TEXT NOT NULL,

  -- RESTRICT: a user that an integration acts as cannot be deleted silently.
  default_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,

  status                 TEXT NOT NULL DEFAULT 'active'
                         CHECK (status IN ('active', 'paused', 'disabled')),

  -- Explicit permission profile; permissions never imply one another.
  permissions            TEXT[] NOT NULL,

  allowed_ip_ranges      CIDR[],

  rate_limit_per_minute  INT NOT NULL DEFAULT 60 CHECK (rate_limit_per_minute > 0),

  -- Credential policy for THIS integration: default lifetime of newly issued
  -- credentials (NULL = no expiry) and how long previous credentials keep
  -- working after a rotation (0 = revoke immediately).
  credential_ttl_days    INT CHECK (credential_ttl_days IS NULL OR credential_ttl_days > 0),
  rotation_grace_hours   INT NOT NULL DEFAULT 24 CHECK (rotation_grace_hours >= 0),

  paused_at              TIMESTAMPTZ,
  paused_by              UUID REFERENCES platform_staff(user_id) ON DELETE SET NULL,
  pause_reason           TEXT,

  disabled_at            TIMESTAMPTZ,
  disabled_by            UUID REFERENCES platform_staff(user_id) ON DELETE SET NULL,
  disable_reason         TEXT,

  created_by             UUID REFERENCES platform_staff(user_id) ON DELETE SET NULL,
  updated_by             UUID REFERENCES platform_staff(user_id) ON DELETE SET NULL,

  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),

  CHECK (cardinality(permissions) > 0),
  -- Only supported permissions may be stored (mirrors IntegrationPermission in code).
  CHECK (permissions <@ ARRAY[
    'stores.list', 'stores.read', 'stores.create', 'stores.update',
    'cases.list', 'cases.read', 'cases.create',
    'messages.list', 'messages.create',
    'files.requirements.read', 'files.upload'
  ]::text[])
);

-- Deliberately NOT unique on account_id: an account may have many integrations.
CREATE INDEX IF NOT EXISTS idx_integration_clients_account ON integration_clients (account_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_clients_account_name
  ON integration_clients (account_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_integration_clients_default_user ON integration_clients (default_user_id);

-- default_user_id must belong to the same account; keeps updated_at current.
CREATE OR REPLACE FUNCTION integration_clients_validate() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = NEW.default_user_id AND account_id = NEW.account_id) THEN
    RAISE EXCEPTION 'default_user_id must be a user of the same account' USING ERRCODE = '23514';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_integration_clients_validate ON integration_clients;
CREATE TRIGGER trg_integration_clients_validate
  BEFORE INSERT OR UPDATE ON integration_clients
  FOR EACH ROW EXECUTE FUNCTION integration_clients_validate();

-- One integration may hold several credentials (safe rotation). Credentials
-- inherit the integration's permission profile — it is never copied here.
CREATE TABLE IF NOT EXISTS integration_credentials (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_client_id  UUID NOT NULL REFERENCES integration_clients(id) ON DELETE CASCADE,

  label                  TEXT,
  key_prefix             TEXT NOT NULL,          -- non-secret, for display only
  key_hash               TEXT NOT NULL UNIQUE,   -- SHA-256 of the raw key

  expires_at             TIMESTAMPTZ,
  revoked_at             TIMESTAMPTZ,
  revoked_by             UUID REFERENCES platform_staff(user_id) ON DELETE SET NULL,
  revoke_reason          TEXT,

  last_used_at           TIMESTAMPTZ,
  last_used_ip           INET,

  created_by             UUID REFERENCES platform_staff(user_id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_client ON integration_credentials (integration_client_id);

-- Idempotency is namespaced by integration: two integrations may reuse a key.
CREATE TABLE IF NOT EXISTS integration_idempotency_keys (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_client_id  UUID NOT NULL REFERENCES integration_clients(id) ON DELETE CASCADE,
  operation              TEXT NOT NULL,
  idempotency_key        TEXT NOT NULL,
  request_hash           TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'in_progress' CHECK (state IN ('in_progress', 'completed')),
  response_status        INT,
  response_body          JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL DEFAULT now() + interval '24 hours',
  UNIQUE (integration_client_id, operation, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_integration_idempotency_expiry ON integration_idempotency_keys (expires_at);

-- Per-request API events and integration configuration events. Never holds
-- credentials, authorization headers, message bodies or file contents.
CREATE TABLE IF NOT EXISTS integration_audit_events (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type             TEXT NOT NULL DEFAULT 'api_request' CHECK (event_type IN ('api_request', 'config')),

  integration_client_id  UUID REFERENCES integration_clients(id) ON DELETE SET NULL,
  integration_name       TEXT,
  credential_id          UUID,
  account_id             UUID,
  default_user_id        UUID,

  required_permission    TEXT,
  operation              TEXT NOT NULL,
  resource_type          TEXT,
  resource_id            TEXT,
  outcome                TEXT NOT NULL,           -- success | denied | rate_limited | error | ...
  http_status            INT,
  error_code             TEXT,

  request_id             TEXT,
  source_ip              INET,
  duration_ms            INT,
  metadata               JSONB
);
CREATE INDEX IF NOT EXISTS idx_integration_audit_integration ON integration_audit_events (integration_client_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_integration_audit_account ON integration_audit_events (account_id, occurred_at DESC);
