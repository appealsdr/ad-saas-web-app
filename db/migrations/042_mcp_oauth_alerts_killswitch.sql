-- 042_mcp_oauth_alerts_killswitch.sql (AD-1969)
-- OAuth sign-in for the MCP connector, security alerts, and the kill switches.

-- Per-account switch for the AI connector (/mcp + OAuth). Off by default; platform admins enable it per account.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS mcp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- Platform-wide switches. 'mcp_enabled' = global kill switch for the whole connector (TRUE = running).
CREATE TABLE IF NOT EXISTS platform_flags (
  key            TEXT PRIMARY KEY,
  bool_value     BOOLEAN NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by_ref TEXT
);
INSERT INTO platform_flags (key, bool_value) VALUES ('mcp_enabled', TRUE) ON CONFLICT (key) DO NOTHING;

-- OAuth clients registered dynamically by MCP clients (public clients, PKCE only — no client secret).
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL CHECK (char_length(client_name) <= 100),
  redirect_uris  TEXT[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A grant = one customer user's consent for one client. It is also the "connection" shown to the user.
-- Each grant is backed by a hidden integration_clients row, so pause/disable, rate limit, idempotency and audit all apply.
CREATE TABLE IF NOT EXISTS oauth_grants (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id              TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  client_name            TEXT NOT NULL,
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id             UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  scopes                 TEXT[] NOT NULL,
  integration_client_id  UUID REFERENCES integration_clients(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at           TIMESTAMPTZ,
  revoked_at             TIMESTAMPTZ,
  revoked_reason         TEXT
);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_account ON oauth_grants (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_oauth_grants_user ON oauth_grants (user_id);

-- Single-use authorization codes (hash only), 60 s lifetime.
CREATE TABLE IF NOT EXISTS oauth_auth_codes (
  code_hash       TEXT PRIMARY KEY,
  grant_id        UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL,
  resource        TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ
);

-- Access (15 min) and refresh (30 days, rotating) tokens — SHA-256 hashes only.
-- Re-using a rotated refresh token revokes the whole grant.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id    UUID NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('access', 'refresh')),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  revoked_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_grant ON oauth_tokens (grant_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expiry ON oauth_tokens (expires_at);

-- Marks integrations that belong to an OAuth grant (not created by staff).
ALTER TABLE integration_clients ADD COLUMN IF NOT EXISTS oauth_grant_id UUID;

-- Security alerts raised by the platform (token reuse, malware, repeated denials, unusual volume, kill-switch changes).
CREATE TABLE IF NOT EXISTS security_alerts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  kind             TEXT NOT NULL,
  severity         TEXT NOT NULL CHECK (severity IN ('info', 'medium', 'high')),
  account_id       UUID,
  subject_type     TEXT,
  subject_id       TEXT,
  message          TEXT NOT NULL,
  metadata         JSONB,
  acknowledged_at  TIMESTAMPTZ,
  acknowledged_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_security_alerts_open ON security_alerts (created_at DESC) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_security_alerts_dedupe ON security_alerts (kind, subject_id, created_at DESC);
