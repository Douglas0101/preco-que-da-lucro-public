DROP TRIGGER IF EXISTS sales_items_totals_validate ON public.sales_items;
DROP TRIGGER IF EXISTS sales_totals_validate ON public.sales;
DROP FUNCTION IF EXISTS app_private.validate_sale_totals();
GRANT SELECT, INSERT, UPDATE ON TABLE public.sales, public.sales_items TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON TABLE public.simulations TO app_runtime;
ALTER TABLE public.sales_items
  DROP CONSTRAINT IF EXISTS sales_items_total_amount_math_check;
ALTER TABLE public.sales
  DROP CONSTRAINT IF EXISTS sales_net_amount_check;
ALTER TABLE public.sales
  ADD CONSTRAINT sales_net_amount_check CHECK (net_amount >= 0);
ALTER TABLE public.purchase_price_history
  DROP CONSTRAINT IF EXISTS purchase_price_history_target_check;
ALTER TABLE public.purchase_price_history
  DROP CONSTRAINT IF EXISTS purchase_price_history_tenant_id_ingredient_id_product_ingredients_tenant_id_id_fk;
ALTER TABLE public.purchase_price_history
  DROP CONSTRAINT IF EXISTS purchase_price_history_tenant_id_packaging_id_product_packaging_tenant_id_id_fk;
DROP INDEX IF EXISTS public.purchase_price_history_tenant_ingredient_valid_idx;
DROP INDEX IF EXISTS public.purchase_price_history_tenant_packaging_valid_idx;
ALTER TABLE public.purchase_price_history
  DROP COLUMN IF EXISTS ingredient_id,
  DROP COLUMN IF EXISTS packaging_id;
