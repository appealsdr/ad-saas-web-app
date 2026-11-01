-- samdoctor-web initial schema
-- Applied automatically by the Postgres container on first start
-- (mounted into /docker-entrypoint-initdb.d via docker-compose.yml).
-- To re-apply manually:
--   psql "$DATABASE_URL" -f db/migrations/001_init.sql

-- Required for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- users: source of truth for auth
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT UNIQUE NOT NULL,
  display_name    TEXT,
  avatar_url      TEXT,
  password_hash   TEXT,                    -- null for OAuth-only users
  sfdc_contact_id TEXT,                    -- Salesforce Contact ID
  sfdc_account_id TEXT,                    -- Salesforce Account ID
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS idx_users_sfdc_contact_id
  ON users (sfdc_contact_id) WHERE sfdc_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_sfdc_account_id
  ON users (sfdc_account_id) WHERE sfdc_account_id IS NOT NULL;

-- Keep users.updated_at fresh on UPDATE
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- oauth_accounts: OAuth providers linked to users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS oauth_accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,             -- 'google' | 'apple'
  provider_uid  TEXT NOT NULL,             -- provider's user ID
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    TIMESTAMPTZ,
  UNIQUE (provider, provider_uid)
);

CREATE INDEX IF NOT EXISTS idx_oauth_accounts_user_id
  ON oauth_accounts (user_id);

-- ---------------------------------------------------------------------------
-- sessions: JWT records stored for revocation support
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT UNIQUE NOT NULL,        -- hash of JWT
  expires_at  TIMESTAMPTZ NOT NULL,        -- typically now() + 3h
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address  INET,
  user_agent  TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id
  ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
  ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- activity_log: audit / analytics
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  session_id  UUID,
  event_type  TEXT NOT NULL,               -- 'login' | 'page_view' | 'action'
  event_data  JSONB,                       -- screen name, metadata
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address  INET
);

CREATE INDEX IF NOT EXISTS idx_activity_log_user_created
  ON activity_log (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_event_type_created
  ON activity_log (event_type, created_at DESC);

-- ---------------------------------------------------------------------------
-- sfdc_sync_queue: outbound writes to Salesforce
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdc_sync_queue (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation    TEXT NOT NULL,              -- 'upsert' | 'delete'
  sfdc_object  TEXT NOT NULL,              -- 'Account' | 'Contact' | etc.
  record_id    TEXT,                       -- local or SFDC ID
  payload      JSONB NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'processing' | 'done' | 'failed'
  attempts     INT NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Worker polls for pending rows oldest-first
CREATE INDEX IF NOT EXISTS idx_sfdc_sync_queue_status_created
  ON sfdc_sync_queue (status, created_at)
  WHERE status IN ('pending', 'processing');

-- ---------------------------------------------------------------------------
-- sfdc_records: local mirror of Salesforce records
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sfdc_records (
  sfdc_id     TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  data        JSONB NOT NULL,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sfdc_records_object_type
  ON sfdc_records (object_type);
