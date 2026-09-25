ALTER TABLE "sales" DROP CONSTRAINT "sales_net_amount_check";--> statement-breakpoint
ALTER TABLE "purchase_price_history" ADD COLUMN "ingredient_id" uuid;--> statement-breakpoint
ALTER TABLE "purchase_price_history" ADD COLUMN "packaging_id" uuid;--> statement-breakpoint
-- Convert the legacy discriminator into explicit tenant-scoped targets before
-- enforcing the new foreign keys. The migration intentionally aborts if an
-- existing history row points at an orphan.
UPDATE "purchase_price_history" AS history
SET "ingredient_id" = history."subject_id"
WHERE history."subject_type" = 'ingredient';--> statement-breakpoint
UPDATE "purchase_price_history" AS history
SET "packaging_id" = history."subject_id"
WHERE history."subject_type" = 'packaging';--> statement-breakpoint
DO $purchase_price_backfill$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "purchase_price_history" AS history
    LEFT JOIN "product_ingredients" AS ingredient
      ON ingredient."tenant_id" = history."tenant_id"
     AND ingredient."id" = history."ingredient_id"
    LEFT JOIN "product_packaging" AS packaging
      ON packaging."tenant_id" = history."tenant_id"
     AND packaging."id" = history."packaging_id"
    WHERE (history."subject_type" = 'ingredient' AND ingredient."id" IS NULL)
       OR (history."subject_type" = 'packaging' AND packaging."id" IS NULL)
  ) THEN
    RAISE EXCEPTION 'purchase_price_history contains an orphaned target';
  END IF;
END
$purchase_price_backfill$;--> statement-breakpoint
ALTER TABLE "purchase_price_history" ADD CONSTRAINT "purchase_price_history_tenant_id_ingredient_id_product_ingredients_tenant_id_id_fk" FOREIGN KEY ("tenant_id","ingredient_id") REFERENCES "public"."product_ingredients"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_price_history" ADD CONSTRAINT "purchase_price_history_tenant_id_packaging_id_product_packaging_tenant_id_id_fk" FOREIGN KEY ("tenant_id","packaging_id") REFERENCES "public"."product_packaging"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "purchase_price_history_tenant_ingredient_valid_idx" ON "purchase_price_history" USING btree ("tenant_id","ingredient_id","valid_from");--> statement-breakpoint
CREATE INDEX "purchase_price_history_tenant_packaging_valid_idx" ON "purchase_price_history" USING btree ("tenant_id","packaging_id","valid_from");--> statement-breakpoint
ALTER TABLE "purchase_price_history" ADD CONSTRAINT "purchase_price_history_target_check" CHECK ((
        ("purchase_price_history"."subject_type" = 'ingredient'
          and "purchase_price_history"."ingredient_id" is not null
          and "purchase_price_history"."packaging_id" is null
          and "purchase_price_history"."subject_id" = "purchase_price_history"."ingredient_id")
        or
        ("purchase_price_history"."subject_type" = 'packaging'
          and "purchase_price_history"."ingredient_id" is null
          and "purchase_price_history"."packaging_id" is not null
          and "purchase_price_history"."subject_id" = "purchase_price_history"."packaging_id")
      ));--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_net_amount_check" CHECK ("sales"."net_amount" >= 0 and "sales"."net_amount" <= "sales"."gross_amount");--> statement-breakpoint
ALTER TABLE "sales_items" ADD CONSTRAINT "sales_items_total_amount_math_check" CHECK ("sales_items"."total_amount" = round("sales_items"."quantity" * "sales_items"."unit_price", 4));
--> statement-breakpoint
-- Sales are append-only at runtime. The deferred trigger below protects the
-- aggregate contract even when an authorized client writes SQL directly.
REVOKE UPDATE ON TABLE "sales", "sales_items", "simulations" FROM app_runtime;--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_private.validate_sale_totals()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, app_private
AS $sale_totals$
DECLARE
  target_sale_id uuid;
  target_tenant_id uuid;
  expected_gross numeric;
  actual_gross numeric;
  item_count integer;
BEGIN
  IF TG_TABLE_NAME = 'sales' THEN
    IF TG_OP = 'DELETE' THEN
      target_sale_id := OLD.id;
      target_tenant_id := OLD.tenant_id;
    ELSE
      target_sale_id := NEW.id;
      target_tenant_id := NEW.tenant_id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN
      target_sale_id := OLD.sale_id;
      target_tenant_id := OLD.tenant_id;
    ELSE
      target_sale_id := NEW.sale_id;
      target_tenant_id := NEW.tenant_id;
    END IF;
  END IF;

  SELECT gross_amount
    INTO actual_gross
    FROM public.sales
   WHERE tenant_id = target_tenant_id
     AND id = target_sale_id;
  IF NOT FOUND THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  SELECT count(*)::integer, COALESCE(sum(total_amount), 0)
    INTO item_count, expected_gross
    FROM public.sales_items
   WHERE tenant_id = target_tenant_id
     AND sale_id = target_sale_id;
  IF item_count = 0 THEN
    RAISE EXCEPTION 'SALE_REQUIRES_ITEM';
  END IF;
  IF expected_gross <> actual_gross THEN
    RAISE EXCEPTION 'SALE_GROSS_MISMATCH';
  END IF;

  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$sale_totals$;--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.validate_sale_totals() FROM PUBLIC;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sales_totals_validate
AFTER INSERT OR UPDATE OR DELETE ON public.sales
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.validate_sale_totals();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER sales_items_totals_validate
AFTER INSERT OR UPDATE OR DELETE ON public.sales_items
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION app_private.validate_sale_totals();
