-- 046_files_download_permission.sql
-- Allow the new `files.download` API permission. Existing integrations are NOT changed: an admin grants it.
-- (044/045 belong to the Stripe payment branches.)
DO $$
DECLARE c RECORD;
BEGIN
  -- The allowlist CHECK from 039 is unnamed, so find it (or an earlier run of this file) by what it lists.
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.integration_clients'::regclass AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%files.upload%'
  LOOP
    EXECUTE format('ALTER TABLE integration_clients DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE integration_clients
  ADD CONSTRAINT integration_clients_permissions_allowed CHECK (permissions <@ ARRAY[
    'stores.list', 'stores.read', 'stores.create', 'stores.update',
    'cases.list', 'cases.read', 'cases.create',
    'messages.list', 'messages.create',
    'files.requirements.read', 'files.upload', 'files.download'
  ]::text[]);
