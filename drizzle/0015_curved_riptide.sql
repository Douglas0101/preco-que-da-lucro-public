CREATE TABLE "outbox_consumptions" (
	"consumer_name" text NOT NULL,
	"event_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_consumptions_consumer_name_event_id_pk" PRIMARY KEY("consumer_name","event_id")
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_events_status_check" CHECK ("outbox_events"."status" in ('pending', 'processing', 'processed', 'failed')),
	CONSTRAINT "outbox_events_attempts_check" CHECK ("outbox_events"."attempts" >= 0),
	CONSTRAINT "outbox_events_identity_check" CHECK ("outbox_events"."event_type" <> '' and "outbox_events"."aggregate_type" <> '' and "outbox_events"."aggregate_id" <> '' and "outbox_events"."idempotency_key" <> '')
);
--> statement-breakpoint
ALTER TABLE "outbox_consumptions" ADD CONSTRAINT "outbox_consumptions_event_id_outbox_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."outbox_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_consumptions" ADD CONSTRAINT "outbox_consumptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_tenant_idempotency_uidx" ON "outbox_events" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_events_claim_idx" ON "outbox_events" USING btree ("tenant_id","status","available_at","created_at");--> statement-breakpoint
-- §23 + M-04: grants mínimos e RLS fail-closed por tenant, no padrão de
-- `ai_usage` (drizzle/0006_loud_lockjaw.sql:25-35). O worker precisa de SELECT
-- (claim), INSERT (append) e UPDATE (marcar processing/processed/failed) em
-- outbox_events; a inbox do consumidor é append-only (SELECT/INSERT).
REVOKE ALL ON TABLE "outbox_events" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "outbox_consumptions" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "outbox_events" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "outbox_consumptions" TO app_runtime;--> statement-breakpoint
ALTER TABLE "outbox_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "outbox_consumptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "outbox_events" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "outbox_consumptions" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);