-- 037_admin_time_zone.sql (AD-1954)
-- Admin display time zone (IANA name, e.g. America/New_York). NULL = use the browser's time zone, else UTC.
-- Every timestamp stays in UTC in the database and API; this only changes how admin pages display them.
ALTER TABLE platform_staff ADD COLUMN IF NOT EXISTS time_zone TEXT;
