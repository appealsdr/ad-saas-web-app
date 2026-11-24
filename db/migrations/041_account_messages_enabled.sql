-- 041_account_messages_enabled.sql (AD-1968)
-- Per-account switch for the global "Messages" sidebar tab / page. Off by default (production does not show it);
-- platform admins enable it per account while the feature is being tested. Account- and store-level message
-- panels on the Account and Store detail screens are NOT affected by this flag.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS messages_enabled BOOLEAN NOT NULL DEFAULT FALSE;
