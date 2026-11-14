-- AD-1946: public signups must verify their email before anything is created in Salesforce / a session is issued.
-- Existing users and other creation paths (admin, signup links) default to NOT pending, so nothing changes for them.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verification_pending BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,               -- snapshot of the email being verified
  token_hash  TEXT UNIQUE NOT NULL,        -- SHA-256 of the raw token (hex)
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,                 -- set when consumed
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_evt_user_id ON email_verification_tokens (user_id);

-- Unverified signups that never confirm are junk: this index supports a periodic cleanup
-- (DELETE FROM users WHERE email_verification_pending AND created_at < now() - interval '7 days').
CREATE INDEX IF NOT EXISTS idx_users_verification_pending ON users (created_at) WHERE email_verification_pending;
