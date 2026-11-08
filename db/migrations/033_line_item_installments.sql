-- 033_line_item_installments.sql
-- Recurring "pay by month": one ContractLineItem per month of the term (Salesforce mirror).
--   seq              position in the Salesforce line-item list (maps local rows to created SF ids deterministically)
--   month_index      1..term for recurring lines (NULL for services / subscriptions)
--   payment_due_date when that month's payment is due (month 1 = the contract start date)
ALTER TABLE service_contract_line_items
  ADD COLUMN IF NOT EXISTS seq INT,
  ADD COLUMN IF NOT EXISTS month_index INT,
  ADD COLUMN IF NOT EXISTS payment_due_date DATE;
