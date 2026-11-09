-- 032_store_documents_multi_file.sql
-- A store-level required-file slot (Required_File__c) can now hold several
-- uploads, like case slots (031). Drop the one-row-per-slot unique index from
-- 009; the plain index (idx_store_documents_case_file) keeps lookups fast.

DROP INDEX IF EXISTS uq_store_documents_case_file;
