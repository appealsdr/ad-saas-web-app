-- 026_read_only_sessions.sql
-- "View as user": a platform admin can open a read-only customer session.
--   read_only        the session may browse but every mutating request is rejected
--   impersonated_by  the staff user who started it (audit / banner)
-- Apply BEFORE deploying code that reads these columns.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS read_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS impersonated_by UUID REFERENCES users(id) ON DELETE SET NULL;
