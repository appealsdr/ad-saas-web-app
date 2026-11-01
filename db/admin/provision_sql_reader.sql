-- Provision the read-only SQL reader role used by /admin/data (inline SQL).
--
-- Run ONCE per environment as a superuser/DB owner — NOT as part of app startup:
--
--   psql "$OWNER_DATABASE_URL" \
--     -v reader_password="$(openssl rand -hex 24)" \
--     -v app_role=samdoctor_app \
--     -f db/admin/provision_sql_reader.sql
--
-- then set ADMIN_READONLY_DATABASE_URL to the reader login. Re-running rotates
-- the password and re-applies grants (idempotent).
--
-- `app_role` is the role the web app itself connects as; it is granted TEMP back
-- because this script revokes TEMP from PUBLIC (so the reader cannot create
-- temporary tables). Omit it if the app owns the database.

\set ON_ERROR_STOP on
\if :{?app_role}
\else
  \set app_role ''
\endif

SELECT NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'admin_sql_reader') AS need_create \gset
\if :need_create
  CREATE ROLE admin_sql_reader LOGIN
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT
    CONNECTION LIMIT 5;
\endif

ALTER ROLE admin_sql_reader WITH LOGIN PASSWORD :'reader_password';
ALTER ROLE admin_sql_reader SET search_path = reporting;
ALTER ROLE admin_sql_reader SET default_transaction_read_only = on;
ALTER ROLE admin_sql_reader SET statement_timeout = '5s';
ALTER ROLE admin_sql_reader SET lock_timeout = '1s';
ALTER ROLE admin_sql_reader SET idle_in_transaction_session_timeout = '10s';

-- Start from nothing: strip anything previously granted (including via old runs).
REVOKE ALL ON ALL TABLES    IN SCHEMA public    FROM admin_sql_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public    FROM admin_sql_reader;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public    FROM admin_sql_reader;
REVOKE ALL ON SCHEMA public                      FROM admin_sql_reader;
REVOKE ALL ON ALL TABLES    IN SCHEMA reporting FROM admin_sql_reader;

-- PUBLIC defaults that would otherwise reach the reader:
--   * TEMP on the database  -> temp tables
--   * USAGE on schema public (PG < 15 also CREATE)
--   * EXECUTE on functions in public
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- PUBLIC EXECUTE on functions in public is deliberately left alone (the app may
-- rely on it); the SQL validator only allows an allowlist of functions and
-- only relations in the reporting schema, and the integration tests run the
-- real role against adversarial queries.
SELECT format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database()) AS q \gexec
SELECT format('REVOKE CREATE ON DATABASE %I FROM PUBLIC', current_database()) AS q \gexec
\if :{?app_role}
  SELECT CASE WHEN :'app_role' <> '' THEN
    format('GRANT TEMPORARY ON DATABASE %I TO %I', current_database(), :'app_role') END AS q \gexec
\endif

-- The only things the reader may touch:
GRANT CONNECT ON DATABASE :"DBNAME" TO admin_sql_reader;
GRANT USAGE ON SCHEMA reporting TO admin_sql_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO admin_sql_reader;
-- Views added by later migrations must be granted explicitly after review
-- (re-run this script) — no default privileges on purpose.

-- Self-check: the reader must own nothing and have no base-table access.
SELECT count(*) > 0 AS reader_has_extra
FROM information_schema.role_table_grants
WHERE grantee = 'admin_sql_reader' AND table_schema <> 'reporting' \gset
\if :reader_has_extra
  \echo 'ERROR: reader has privileges outside the reporting schema'
  \quit 1
\endif
\echo 'admin_sql_reader provisioned.'
