-- 023_platform_admin.sql
-- Platform administration: independent staff membership, MFA, admin sessions,
-- immutable audit log, and log-correlation columns.
--
-- Platform roles are NOT the customer roles in users.role ('owner' | 'admin' |
-- 'member'). Nothing here reads or writes users.role.

-- ─── Staff membership ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS platform_staff (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE RESTRICT,
  role            TEXT NOT NULL CHECK (role IN ('platform_admin', 'platform_viewer')),
  is_active       BOOLEAN NOT NULL DEFAULT true,
  granted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_by_ref  TEXT,                       -- durable actor reference (email or 'cli:<os-user>')
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deactivated_at  TIMESTAMPTZ
);

DROP TRIGGER IF EXISTS trg_platform_staff_updated_at ON platform_staff;
CREATE TRIGGER trg_platform_staff_updated_at
  BEFORE UPDATE ON platform_staff
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- DB-level backstop: the last active platform_admin can never be demoted,
-- deactivated or deleted, even by two concurrent transactions. The advisory
-- lock serialises membership changes; each statement then sees the other
-- transaction's committed result (READ COMMITTED).
CREATE OR REPLACE FUNCTION platform_staff_guard_last_admin()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('platform_staff_membership'));
  IF OLD.role = 'platform_admin' AND OLD.is_active
     AND (TG_OP = 'DELETE' OR NEW.role <> 'platform_admin' OR NOT NEW.is_active) THEN
    IF NOT EXISTS (
      SELECT 1 FROM platform_staff
      WHERE role = 'platform_admin' AND is_active AND id <> OLD.id
    ) THEN
      RAISE EXCEPTION 'cannot remove the last active platform_admin'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_staff_last_admin ON platform_staff;
CREATE TRIGGER trg_platform_staff_last_admin
  BEFORE UPDATE OR DELETE ON platform_staff
  FOR EACH ROW EXECUTE FUNCTION platform_staff_guard_last_admin();

-- ─── MFA ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_mfa_credentials (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted TEXT NOT NULL,             -- AES-256-GCM, see ADMIN_MFA_ENCRYPTION_KEY
  confirmed_at     TIMESTAMPTZ,               -- NULL until the first valid code is entered
  last_used_step   BIGINT,                    -- TOTP time step; replay protection
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,                   -- SHA-256 of the normalised code (never the raw code)
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_admin_recovery_codes_user
  ON admin_recovery_codes (user_id) WHERE used_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_recovery_codes_hash
  ON admin_recovery_codes (user_id, code_hash);

-- Short-lived state between password check and MFA completion. Grants no
-- data access; consumed (or expired) before an admin session exists.
CREATE TABLE IF NOT EXISTS admin_login_challenges (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stage       TEXT NOT NULL CHECK (stage IN ('mfa_enroll', 'mfa_challenge')),
  next_path   TEXT,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip_address  INET
);
CREATE INDEX IF NOT EXISTS idx_admin_login_challenges_expires
  ON admin_login_challenges (expires_at);

-- ─── Admin sessions (separate from customer `sessions`) ────────────────────
CREATE TABLE IF NOT EXISTS admin_sessions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash       TEXT NOT NULL UNIQUE,
  mfa_verified_at  TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at       TIMESTAMPTZ NOT NULL,      -- absolute lifetime
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at       TIMESTAMPTZ,
  revoked_reason   TEXT,
  revoked_by       UUID REFERENCES users(id) ON DELETE SET NULL,
  ip_address       INET,
  user_agent       TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_user
  ON admin_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires
  ON admin_sessions (expires_at);

-- ─── Cross-replica rate limiting ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_rate_limits (
  key            TEXT PRIMARY KEY,
  window_start   TIMESTAMPTZ NOT NULL DEFAULT now(),
  count          INT NOT NULL DEFAULT 0
);

-- One active read-only SQL query per administrator, across replicas.
CREATE TABLE IF NOT EXISTS admin_sql_active (
  user_id     UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL            -- safety net if a replica dies mid-query
);

-- ─── Immutable audit log ───────────────────────────────────────────────────
-- No foreign keys on purpose: events must survive removal of users/accounts.
CREATE TABLE IF NOT EXISTS admin_audit_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_user_id      UUID,
  actor_ref          TEXT NOT NULL,           -- durable: email (or 'cli:<os-user>', 'anonymous')
  actor_role         TEXT,
  action             TEXT NOT NULL,           -- e.g. 'staff.login', 'sql.execute', 'user.suspend'
  target_type        TEXT,
  target_id          TEXT,
  target_account_id  UUID,
  outcome            TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'denied', 'pending')),
  reason             TEXT,
  request_id         TEXT,
  ip_address         INET,
  metadata           JSONB                    -- redacted before insert
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_occurred
  ON admin_audit_events (occurred_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_admin_audit_actor
  ON admin_audit_events (actor_user_id, occurred_at DESC) WHERE actor_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_account
  ON admin_audit_events (target_account_id, occurred_at DESC) WHERE target_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_admin_audit_action
  ON admin_audit_events (action, occurred_at DESC);

CREATE OR REPLACE FUNCTION admin_audit_events_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_events is append-only' USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_admin_audit_no_update ON admin_audit_events;
CREATE TRIGGER trg_admin_audit_no_update
  BEFORE UPDATE OR DELETE ON admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION admin_audit_events_immutable();

DROP TRIGGER IF EXISTS trg_admin_audit_no_truncate ON admin_audit_events;
CREATE TRIGGER trg_admin_audit_no_truncate
  BEFORE TRUNCATE ON admin_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION admin_audit_events_immutable();

-- ─── Log correlation (new writes only; history is never re-attributed) ─────
ALTER TABLE error_log    ADD COLUMN IF NOT EXISTS request_id TEXT;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS account_id UUID;
ALTER TABLE activity_log ADD COLUMN IF NOT EXISTS request_id TEXT;

CREATE INDEX IF NOT EXISTS idx_error_log_request
  ON error_log (request_id) WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_error_log_created_id
  ON error_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_operation
  ON error_log (operation, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_created_id
  ON activity_log (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_log_account
  ON activity_log (account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_activity_log_request
  ON activity_log (request_id) WHERE request_id IS NOT NULL;
