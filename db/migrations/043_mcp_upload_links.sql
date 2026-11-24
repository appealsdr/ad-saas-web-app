-- 043_mcp_upload_links.sql (AD-1969)
-- One-time, short-lived links that let a customer upload a REAL file into ONE required-file slot from a browser page,
-- instead of pushing base64 through the chat. Created by the MCP tool `create_upload_link`.
-- Only the SHA-256 of the token is stored; the link is single-use, expires quickly and is bound to one account/store/slot.
CREATE TABLE IF NOT EXISTS upload_links (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash         TEXT NOT NULL UNIQUE,
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id           UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sfdc_case_id       TEXT,
  required_file_id   TEXT NOT NULL,
  replace_existing   BOOLEAN NOT NULL DEFAULT FALSE,
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration_id     UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  used_at            TIMESTAMPTZ,
  uploaded_file_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_upload_links_account ON upload_links (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_upload_links_expiry ON upload_links (expires_at);
