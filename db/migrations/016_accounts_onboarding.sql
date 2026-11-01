-- 016_accounts_onboarding.sql
-- Tracks whether an account finished onboarding (company/phone/website + SF sync).
-- Default TRUE so all existing accounts and password sign-ups are "complete";
-- only first-time Google sign-ups insert FALSE and get sent to /onboarding.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS onboarding_completed BOOLEAN NOT NULL DEFAULT true;
