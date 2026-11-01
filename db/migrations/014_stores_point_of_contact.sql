-- 014_stores_point_of_contact.sql
-- Store-level point of contact (references account_contacts).
-- Default is the account owner / account POC at store creation time.

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS point_of_contact_id UUID REFERENCES account_contacts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stores_point_of_contact
  ON stores (point_of_contact_id) WHERE point_of_contact_id IS NOT NULL;

-- First registered user per account becomes owner (legacy rows defaulted to member).
UPDATE users u
SET role = 'owner'
FROM (
  SELECT DISTINCT ON (account_id) id
  FROM users
  WHERE account_id IS NOT NULL
  ORDER BY account_id, created_at ASC
) first_user
WHERE u.id = first_user.id AND u.role = 'member';

-- Backfill store POC from account-level POC where missing.
UPDATE stores s
SET point_of_contact_id = ac.id
FROM account_contacts ac
WHERE ac.account_id = s.account_id
  AND ac.is_point_of_contact = true
  AND s.point_of_contact_id IS NULL;
