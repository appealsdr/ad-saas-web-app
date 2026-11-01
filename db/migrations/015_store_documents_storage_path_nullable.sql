-- 015_store_documents_storage_path_nullable.sql
-- store_documents.storage_path was NOT NULL from the local-filesystem era.
-- Uploads now go to S3 (s3_key) and leave storage_path NULL (migration 009
-- intended this but never dropped the constraint). Drop it so S3 uploads insert.
ALTER TABLE store_documents ALTER COLUMN storage_path DROP NOT NULL;
