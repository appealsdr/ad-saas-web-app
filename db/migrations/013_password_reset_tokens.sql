-- Password-reset tokens table.
-- Tokens are single-use, expire after 1 hour, and are tied to a user's email
-- at creation time so we can detect if the email changed before the link is used.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,               -- snapshot of email at creation time
  token_hash  TEXT UNIQUE NOT NULL,        -- SHA-256 of the raw token (hex)
  expires_at  TIMESTAMPTZ NOT NULL,        -- now() + 1h
  used_at     TIMESTAMPTZ,                 -- set when consumed; NULL = still valid
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_prt_token_hash ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_prt_user_id    ON password_reset_tokens (user_id);
