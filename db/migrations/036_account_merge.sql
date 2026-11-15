-- AD-1944: merging duplicate customer accounts (admin → Accounts → Account merge).
-- The duplicate ("source") account is retired, never deleted: it keeps whatever data staff chose not to move,
-- and points at the surviving account. account_merges records the choices and every id that was moved (undo data).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS merged_into_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS account_merges (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  survivor_account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source_account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  actor_ref           TEXT NOT NULL,            -- staff email
  reason              TEXT NOT NULL,
  choices             JSONB NOT NULL,           -- what staff selected (no secrets)
  moved               JSONB NOT NULL,           -- ids moved per table
  sf_result           JSONB,                    -- Salesforce re-parenting outcome (null = not attempted)
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_account_merges_survivor ON account_merges (survivor_account_id);
CREATE INDEX IF NOT EXISTS idx_account_merges_source ON account_merges (source_account_id);
