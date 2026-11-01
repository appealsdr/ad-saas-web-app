-- 007_case_documents.sql
-- Files uploaded against a Salesforce Case. Bytes live in S3 (bucket from
-- AWS_S3_BUCKET env var); the row carries the key + metadata so we can list
-- and generate presigned download URLs.
--
-- `sfdc_case_id` is the SF Case Id — NOT a FK because we don't mirror Cases
-- locally. The store_id is the local store the case belongs to (for tenancy
-- enforcement on download).

CREATE TABLE IF NOT EXISTS case_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id        UUID NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  sfdc_case_id    TEXT NOT NULL,
  uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  original_name   TEXT NOT NULL,
  s3_bucket       TEXT NOT NULL,
  s3_key          TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_case_documents_case
  ON case_documents (sfdc_case_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_case_documents_store
  ON case_documents (store_id, created_at DESC);
