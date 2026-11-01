-- 030_standalone_admin_accounts.sql
-- Platform admins become STANDALONE identities: their own email, password and MFA, independent of the
-- customer `users` table. An admin may therefore have exactly the same email as a customer user (with a
-- different password) and is created from the operator console, never by promoting a customer.
--
--   platform_staff      now holds the identity (email, display_name, password_hash, must_reset_password);
--                       platform_staff.user_id stays the admin's id (its name is kept so every admin_* table is unchanged)
--   admin_* tables      user_id / revoked_by now reference platform_staff(user_id), not users(id)
--   sessions.impersonated_by   a staff id (no longer a users row) → no FK
--
-- Existing staff are migrated: credentials are copied from their user row and they get a NEW id, so an admin id
-- never equals a customer id. Their sessions are revoked (they sign in again; MFA enrolment is kept).

ALTER TABLE platform_staff
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS display_name TEXT,
  ADD COLUMN IF NOT EXISTS password_hash TEXT,
  ADD COLUMN IF NOT EXISTS must_reset_password BOOLEAN NOT NULL DEFAULT false;

UPDATE platform_staff ps
SET email = lower(u.email), display_name = u.display_name, password_hash = u.password_hash
FROM users u WHERE u.id = ps.user_id AND ps.email IS NULL;

-- 1. Drop every foreign key from the admin tables (and sessions.impersonated_by) to users(id).
DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT c.conrelid::regclass AS tbl, c.conname
    FROM pg_constraint c
    WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass
      AND ( c.conrelid IN ('public.platform_staff'::regclass, 'public.admin_mfa_credentials'::regclass,
                           'public.admin_recovery_codes'::regclass, 'public.admin_login_challenges'::regclass,
                           'public.admin_sessions'::regclass, 'public.admin_sql_active'::regclass)
            OR (c.conrelid = 'public.sessions'::regclass
                AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attnum = c.conkey[1] AND a.attname = 'impersonated_by')) )
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
  END LOOP;
END $$;

-- 2. New ids for existing staff, applied everywhere an admin id is stored.
CREATE TEMP TABLE _staff_map AS SELECT user_id AS old_id, gen_random_uuid() AS new_id FROM platform_staff;
UPDATE admin_mfa_credentials  t SET user_id = m.new_id FROM _staff_map m WHERE t.user_id = m.old_id;
UPDATE admin_recovery_codes   t SET user_id = m.new_id FROM _staff_map m WHERE t.user_id = m.old_id;
UPDATE admin_login_challenges t SET user_id = m.new_id FROM _staff_map m WHERE t.user_id = m.old_id;
UPDATE admin_sessions         t SET user_id = m.new_id FROM _staff_map m WHERE t.user_id = m.old_id;
UPDATE admin_sql_active       t SET user_id = m.new_id FROM _staff_map m WHERE t.user_id = m.old_id;
UPDATE admin_sessions         t SET revoked_by = m.new_id FROM _staff_map m WHERE t.revoked_by = m.old_id;
UPDATE platform_staff         t SET granted_by = m.new_id FROM _staff_map m WHERE t.granted_by = m.old_id;
-- admin_audit_events is append-only: past rows keep the old actor id (they also carry actor_ref = the admin's email).
UPDATE sessions               t SET impersonated_by = m.new_id FROM _staff_map m WHERE t.impersonated_by = m.old_id;
UPDATE platform_staff         t SET user_id = m.new_id FROM _staff_map m WHERE t.user_id = m.old_id;
DROP TABLE _staff_map;

-- 3. Identity constraints (admins now get their own generated id).
ALTER TABLE platform_staff ALTER COLUMN user_id SET DEFAULT gen_random_uuid();
UPDATE platform_staff SET email = lower(email) WHERE email IS NOT NULL;
ALTER TABLE platform_staff ALTER COLUMN email SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_staff_email ON platform_staff (lower(email));

-- 4. Admin tables now belong to the admin identity.
ALTER TABLE platform_staff        ADD CONSTRAINT platform_staff_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES platform_staff(user_id) ON DELETE SET NULL;
ALTER TABLE admin_mfa_credentials  ADD CONSTRAINT admin_mfa_credentials_user_fkey FOREIGN KEY (user_id) REFERENCES platform_staff(user_id) ON DELETE CASCADE;
ALTER TABLE admin_recovery_codes   ADD CONSTRAINT admin_recovery_codes_user_fkey  FOREIGN KEY (user_id) REFERENCES platform_staff(user_id) ON DELETE CASCADE;
ALTER TABLE admin_login_challenges ADD CONSTRAINT admin_login_challenges_user_fkey FOREIGN KEY (user_id) REFERENCES platform_staff(user_id) ON DELETE CASCADE;
ALTER TABLE admin_sql_active       ADD CONSTRAINT admin_sql_active_user_id_fkey FOREIGN KEY (user_id) REFERENCES platform_staff(user_id) ON DELETE CASCADE;
ALTER TABLE admin_sessions         ADD CONSTRAINT admin_sessions_user_fkey FOREIGN KEY (user_id) REFERENCES platform_staff(user_id) ON DELETE CASCADE;
ALTER TABLE admin_sessions         ADD CONSTRAINT admin_sessions_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES platform_staff(user_id) ON DELETE SET NULL;

-- Existing admin sessions belong to the old identity: sign in again (MFA enrolment is kept).
UPDATE admin_sessions SET revoked_at = now(), revoked_reason = 'identity_migrated' WHERE revoked_at IS NULL;

-- 5. Admin reporting projection: add the identity columns (never the password hash).
CREATE OR REPLACE VIEW reporting.platform_staff WITH (security_barrier = true) AS
  SELECT id, user_id, role, is_active, granted_by, created_at, updated_at, deactivated_at, email, display_name, must_reset_password
  FROM public.platform_staff;
