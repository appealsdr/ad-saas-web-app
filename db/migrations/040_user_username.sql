-- 040_user_username.sql (AD-1956)
-- A distinct, admin-editable username field, separate from the sign-in email
-- and the Salesforce-synced display name. Not pushed to Salesforce (there is
-- no corresponding Contact field). Uniqueness is case-insensitive.
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower
  ON users (lower(username))
  WHERE username IS NOT NULL;
