-- 038_usage_dashboard_indexes.sql (AD-1954)
-- Admin usage dashboard: aggregate page views / time-on-page by path and period without a full scan.
-- (user_id, created_at) and (event_type, created_at) already exist (001_init.sql); this adds (path, created_at).
CREATE INDEX IF NOT EXISTS idx_activity_log_path_created
  ON activity_log ((event_data->>'path'), created_at DESC)
  WHERE event_type IN ('page_view', 'page_time');
