-- 010_stores_spapi_callback.sql
-- Persist the raw OAuth callback Amazon sent us, so:
--   - we have an audit trail of who Amazon thinks authorized
--   - debugging "why isn't this store seeing tokens" doesn't require log digging
--   - if Amazon adds new params to the callback (mws_auth_token, region, etc.)
--     we capture them without code changes.
--
-- The JSONB blob holds the whole query string minus `spapi_oauth_code` (which
-- is one-time use and shouldn't be retained in storage).

ALTER TABLE stores
  ADD COLUMN IF NOT EXISTS spapi_callback_params JSONB;
