-- 028_line_item_balance_due.sql
-- Deposit services are paid in parts. The customer pays Full-price lines and the Deposit of Deposit
-- lines at checkout; the remainder of each Deposit line is a separate Pending Salesforce Payment__c
-- (linked to that ContractLineItem) collected when the case is completed. balance_due remembers
-- that remainder per line so a failed Salesforce sync can be rebuilt exactly.
ALTER TABLE service_contract_line_items
  ADD COLUMN IF NOT EXISTS balance_due NUMERIC(12,2) NOT NULL DEFAULT 0;

-- Expose it in the admin reporting projection (views may only gain columns at the end).
CREATE OR REPLACE VIEW reporting.service_contract_line_items WITH (security_barrier = true) AS
  SELECT id, service_contract_id, product_name, product_category, unit_price, quantity,
         currency, sfdc_product_id, sfdc_contract_line_item_id, created_at, balance_due
  FROM public.service_contract_line_items;
