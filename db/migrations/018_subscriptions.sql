-- 018_subscriptions.sql
-- Store-level subscriptions on top of the existing service_contracts table:
--   - service_contracts.kind    distinguishes a one-off 'service' purchase
--                               from a 12-month 'subscription'.
--   - service_contracts.status  'active' | 'cancelled' — subscribing to a
--                               new plan cancels the store's previous active
--                               subscription contract.
--   - stores.active_service_contract_id points at the store's current
--                               active contract (service or subscription).

ALTER TABLE service_contracts
  ADD COLUMN IF NOT EXISTS kind   TEXT NOT NULL DEFAULT 'service',  -- 'service' | 'subscription'
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';   -- 'active' | 'cancelled'

CREATE INDEX IF NOT EXISTS idx_service_contracts_store_active
  ON service_contracts (store_id) WHERE status = 'active';

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS active_service_contract_id
    UUID REFERENCES service_contracts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_stores_active_service_contract
  ON stores (active_service_contract_id) WHERE active_service_contract_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- ai_chat_messages — one row per question/answer pair from the store-level
-- AI Chat tab (only available while the store has an active subscription).
-- Provider is 'gemini' | 'claude'; conversation_id groups a thread of
-- messages together (one thread per chat session).
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_chat_messages (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  store_id          UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,  -- who asked
  conversation_id   UUID NOT NULL,                                  -- groups a thread

  provider          TEXT NOT NULL,                                  -- 'gemini' | 'claude'
  model             TEXT,                                           -- provider's model id

  question          TEXT NOT NULL,
  answer            TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',                -- 'pending' | 'answered' | 'failed'
  error_message     TEXT,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_store
  ON ai_chat_messages (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_conversation
  ON ai_chat_messages (conversation_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_ai_chat_messages_account
  ON ai_chat_messages (account_id);
