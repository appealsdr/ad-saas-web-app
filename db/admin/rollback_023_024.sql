-- MANUAL rollback of the platform-admin schema (migrations 023 + 024).
-- DESTRUCTIVE: drops staff membership, MFA enrolments, admin sessions and the
-- ADMIN AUDIT TRAIL. Export admin_audit_events first if you need to keep it:
--   \copy admin_audit_events TO 'admin_audit_events.csv' CSV HEADER
-- Not in db/migrations/ on purpose so it can never be applied automatically.
-- The audit table's append-only trigger blocks DELETE/TRUNCATE; DROP TABLE is the
-- only way to remove it, which is why this is a deliberate, manual step.
--
-- Also remove the reader login if you no longer need it:
--   DROP OWNED BY admin_sql_reader; DROP ROLE admin_sql_reader;

BEGIN;
DROP SCHEMA IF EXISTS reporting CASCADE;

DROP TABLE IF EXISTS admin_sql_active;
DROP TABLE IF EXISTS admin_rate_limits;
DROP TABLE IF EXISTS admin_login_challenges;
DROP TABLE IF EXISTS admin_recovery_codes;
DROP TABLE IF EXISTS admin_mfa_credentials;
DROP TABLE IF EXISTS admin_sessions;
DROP TABLE IF EXISTS platform_staff;
DROP TABLE IF EXISTS admin_audit_events;
DROP FUNCTION IF EXISTS platform_staff_guard_last_admin();
DROP FUNCTION IF EXISTS admin_audit_events_immutable();

DROP INDEX IF EXISTS idx_error_log_request, idx_error_log_created_id, idx_error_log_operation,
  idx_activity_log_created_id, idx_activity_log_account, idx_activity_log_request;
ALTER TABLE error_log    DROP COLUMN IF EXISTS request_id;
ALTER TABLE activity_log DROP COLUMN IF EXISTS account_id;
ALTER TABLE activity_log DROP COLUMN IF EXISTS request_id;
COMMIT;
