-- 031_case_documents_multi_file.sql
-- A required-file slot (Case_File__c / Required_File__c) can now hold several
-- uploads. Drop the one-row-per-slot unique index from 008; the plain index
-- (idx_case_documents_case_file) keeps per-slot lookups fast.

DROP INDEX IF EXISTS uq_case_documents_case_file;
