-- 003_accounts_company_fields.sql
-- Registration now collects Company Name, Phone, and Website. Company Name
-- maps to accounts.name (we already had `name` and `phone`), Website is new.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS website TEXT;
