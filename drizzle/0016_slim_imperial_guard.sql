CREATE TABLE "backfill_checkpoints" (
	"tenant_id" uuid NOT NULL,
	"run_key" text NOT NULL,
	"cursor" text,
	"completed" boolean DEFAULT false NOT NULL,
	"batches" integer DEFAULT 0 NOT NULL,
	"rows_scanned" integer DEFAULT 0 NOT NULL,
	"rows_applied" integer DEFAULT 0 NOT NULL,
	"rows_duplicate" integer DEFAULT 0 NOT NULL,
	"errors" integer DEFAULT 0 NOT NULL,
	"version" integer NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "backfill_checkpoints_tenant_id_run_key_pk" PRIMARY KEY("tenant_id","run_key"),
	CONSTRAINT "backfill_checkpoints_identity_check" CHECK ("backfill_checkpoints"."run_key" <> ''),
	CONSTRAINT "backfill_checkpoints_version_check" CHECK ("backfill_checkpoints"."version" >= 0),
	CONSTRAINT "backfill_checkpoints_counters_check" CHECK ("backfill_checkpoints"."batches" >= 0 and "backfill_checkpoints"."rows_scanned" >= 0 and "backfill_checkpoints"."rows_applied" >= 0 and "backfill_checkpoints"."rows_duplicate" >= 0 and "backfill_checkpoints"."errors" >= 0)
);
--> statement-breakpoint
CREATE TABLE "backfill_work_items" (
	"tenant_id" uuid NOT NULL,
	"work_key" text NOT NULL,
	"run_key" text NOT NULL,
	"row_key" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backfill_work_items_tenant_id_work_key_pk" PRIMARY KEY("tenant_id","work_key"),
	CONSTRAINT "backfill_work_items_identity_check" CHECK ("backfill_work_items"."work_key" <> '' and "backfill_work_items"."row_key" <> '' and "backfill_work_items"."run_key" <> '')
);
--> statement-breakpoint
ALTER TABLE "backfill_checkpoints" ADD CONSTRAINT "backfill_checkpoints_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backfill_work_items" ADD CONSTRAINT "backfill_work_items_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backfill_work_items_tenant_run_key_idx" ON "backfill_work_items" USING btree ("tenant_id","run_key");--> statement-breakpoint
-- §28 + WP-1a: grants mínimos e RLS fail-closed por tenant, no padrão de
-- `outbox_events` (drizzle/0015_curved_riptide.sql:38-58). O runner precisa de
-- SELECT (retomada), INSERT (1ª gravação) e UPDATE (CAS do checkpoint) em
-- backfill_checkpoints; os marcadores de idempotência são append-only.
REVOKE ALL ON TABLE "backfill_checkpoints" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "backfill_work_items" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "backfill_checkpoints" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "backfill_work_items" TO app_runtime;--> statement-breakpoint
ALTER TABLE "backfill_checkpoints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "backfill_work_items" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "backfill_checkpoints" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "backfill_work_items" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);