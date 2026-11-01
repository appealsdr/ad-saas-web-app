-- 008_case_documents_required.sql
-- case_documents is now a 1:1 mirror of Salesforce Case_File__c records:
-- each Case_File__c defines a required file for a Case, and we store one
-- case_documents row per upload (re-upload UPSERTs by sfdc_case_file_id).

ALTER TABLE case_documents
  ADD COLUMN IF NOT EXISTS sfdc_case_file_id TEXT;

-- One upload per required-file slot — re-upload UPSERTs over the existing row.
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_documents_case_file
  ON case_documents (sfdc_case_file_id)
  WHERE sfdc_case_file_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_case_documents_case_file
  ON case_documents (sfdc_case_file_id) WHERE sfdc_case_file_id IS NOT NULL;
