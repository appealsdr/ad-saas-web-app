-- 019_password_history.sql
-- Tracks previous password hashes per user so a password change (self-service
-- reset) can reject reuse of a recent password. We never store plaintext —
-- only the same scrypt hash format already used for users.password_hash.
--
-- A row is inserted for the OLD hash at the moment it's replaced (i.e. right
-- before users.password_hash is overwritten), so history holds passwords the
-- user is moving away from, not the brand-new one. Pruned to the most recent
-- PASSWORD_HISTORY_LIMIT rows per user by the application.

CREATE TABLE IF NOT EXISTS password_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_password_history_user
  ON password_history (user_id, created_at DESC);
