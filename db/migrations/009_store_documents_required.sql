-- 009_store_documents_required.sql
-- Mirrors what 008 did for case_documents: store_documents now becomes a
-- 1:1 mirror of Salesforce Case_File__c records whose Store__c is set and
-- Case__c is null (i.e. store-level required documents).
--
-- New columns:
--   s3_bucket / s3_key      — uploads now go to S3 (legacy storage_path stays
--                              for the few rows already on disk).
--   sfdc_case_file_id       — the Case_File__c slot this upload belongs to.
--
-- The old storage_path column is kept for backward compat (NULL going forward).

ALTER TABLE store_documents
  ADD COLUMN IF NOT EXISTS s3_bucket          TEXT,
  ADD COLUMN IF NOT EXISTS s3_key             TEXT,
  ADD COLUMN IF NOT EXISTS sfdc_case_file_id  TEXT;

-- One upload per required-file slot — re-upload UPSERTs.
CREATE UNIQUE INDEX IF NOT EXISTS uq_store_documents_case_file
  ON store_documents (sfdc_case_file_id)
  WHERE sfdc_case_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_store_documents_case_file
  ON store_documents (sfdc_case_file_id) WHERE sfdc_case_file_id IS NOT NULL;
