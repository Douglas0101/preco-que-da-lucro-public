CREATE TABLE "calculation_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"calculation_type" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"outputs" jsonb NOT NULL,
	"engine_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_price_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" uuid NOT NULL,
	"price" numeric(19, 4) NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"unit" text NOT NULL,
	"supplier_id" text,
	"valid_from" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "purchase_price_history_subject_check" CHECK ("purchase_price_history"."subject_type" in ('ingredient', 'packaging')),
	CONSTRAINT "purchase_price_history_price_check" CHECK ("purchase_price_history"."price" >= 0),
	CONSTRAINT "purchase_price_history_quantity_check" CHECK ("purchase_price_history"."quantity" > 0)
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"gross_amount" numeric(19, 4) NOT NULL,
	"net_amount" numeric(19, 4) NOT NULL,
	"channel" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_gross_amount_check" CHECK ("sales"."gross_amount" >= 0),
	CONSTRAINT "sales_net_amount_check" CHECK ("sales"."net_amount" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sales_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sale_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"quantity" numeric(24, 6) NOT NULL,
	"unit_price" numeric(19, 4) NOT NULL,
	"total_amount" numeric(19, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_items_quantity_check" CHECK ("sales_items"."quantity" > 0),
	CONSTRAINT "sales_items_unit_price_check" CHECK ("sales_items"."unit_price" >= 0),
	CONSTRAINT "sales_items_total_amount_check" CHECK ("sales_items"."total_amount" >= 0)
);
--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "simulations" ADD COLUMN "result" jsonb;--> statement-breakpoint
ALTER TABLE "simulations" ADD COLUMN "scenario_type" text DEFAULT 'manual_simulation' NOT NULL;--> statement-breakpoint
ALTER TABLE "simulations" ADD COLUMN "engine_version" text DEFAULT 'finance-engine/2.0.0' NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_snapshots" ADD CONSTRAINT "calculation_snapshots_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_price_history" ADD CONSTRAINT "purchase_price_history_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_items" ADD CONSTRAINT "sales_items_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_items" ADD CONSTRAINT "sales_items_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calculation_snapshots_tenant_id_id_uidx" ON "calculation_snapshots" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "calculation_snapshots_tenant_entity_created_idx" ON "calculation_snapshots" USING btree ("tenant_id","entity_type","entity_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_price_history_tenant_id_id_uidx" ON "purchase_price_history" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "purchase_price_history_tenant_subject_valid_idx" ON "purchase_price_history" USING btree ("tenant_id","subject_type","subject_id","valid_from");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_tenant_id_id_uidx" ON "sales" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "sales_tenant_occurred_idx" ON "sales" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_items_tenant_id_id_uidx" ON "sales_items" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "sales_items_tenant_sale_idx" ON "sales_items" USING btree ("tenant_id","sale_id");--> statement-breakpoint
CREATE INDEX "sales_items_tenant_product_idx" ON "sales_items" USING btree ("tenant_id","product_id");--> statement-breakpoint
-- A FK composta de sales_items exige o índice único de sales já existente.
ALTER TABLE "sales_items" ADD CONSTRAINT "sales_items_tenant_id_sale_id_sales_tenant_id_id_fk" FOREIGN KEY ("tenant_id","sale_id") REFERENCES "public"."sales"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_status_check" CHECK ("products"."status" in ('draft', 'incomplete', 'ready', 'active', 'archived'));--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_scenario_type_check" CHECK ("simulations"."scenario_type" in ('manual_simulation', 'forecast', 'real'));--> statement-breakpoint
-- New tenant-scoped tables are created after the base privilege migration.
-- Keep the runtime role least-privileged and append-only for history/snapshots.
REVOKE ALL ON TABLE "calculation_snapshots", "purchase_price_history", "sales", "sales_items" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "calculation_snapshots", "purchase_price_history" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "sales", "sales_items" TO app_runtime;--> statement-breakpoint
DO $tenant_rls_p1$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'calculation_snapshots',
    'purchase_price_history',
    'sales',
    'sales_items'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO app_runtime USING (
        tenant_id = app_private.current_tenant_id()
        AND app_private.has_tenant_access(tenant_id)
      ) WITH CHECK (
        tenant_id = app_private.current_tenant_id()
        AND app_private.has_tenant_access(tenant_id)
      )',
      table_name
    );
  END LOOP;
END
$tenant_rls_p1$;
