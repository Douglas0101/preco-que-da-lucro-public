CREATE TABLE "ai_memory_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"candidate_content" text NOT NULL,
	"candidate_dedup_key" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "ai_memory_conflicts_status_check" CHECK ("ai_memory_conflicts"."status" in ('open', 'dismissed', 'resolved')),
	CONSTRAINT "ai_memory_conflicts_content_check" CHECK ("ai_memory_conflicts"."candidate_content" <> '')
);
--> statement-breakpoint
CREATE TABLE "ai_memory_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"content" text NOT NULL,
	"dedup_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_memory_versions_tenant_memory_version_uidx" UNIQUE("tenant_id","memory_id","version"),
	CONSTRAINT "ai_memory_versions_version_check" CHECK ("ai_memory_versions"."version" > 0),
	CONSTRAINT "ai_memory_versions_content_check" CHECK ("ai_memory_versions"."content" <> '')
);
--> statement-breakpoint
ALTER TABLE "ai_memories" ADD COLUMN "dedup_key" text NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memory_conflicts" ADD CONSTRAINT "ai_memory_conflicts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_conflicts" ADD CONSTRAINT "ai_memory_conflicts_tenant_id_memory_id_ai_memories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","memory_id") REFERENCES "public"."ai_memories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_versions" ADD CONSTRAINT "ai_memory_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_versions" ADD CONSTRAINT "ai_memory_versions_tenant_id_memory_id_ai_memories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","memory_id") REFERENCES "public"."ai_memories"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_memory_conflicts_tenant_memory_idx" ON "ai_memory_conflicts" USING btree ("tenant_id","memory_id");--> statement-breakpoint
CREATE INDEX "ai_memory_conflicts_tenant_status_idx" ON "ai_memory_conflicts" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_memories_tenant_dedup_key_active_uidx" ON "ai_memories" USING btree ("tenant_id","dedup_key") WHERE "ai_memories"."status" = 'active';
;--> statement-breakpoint
-- §43/§15.8: grants mínimos e RLS fail-closed por tenant, no padrão de
-- `ai_memories`/`ai_memory_sources` (drizzle/0017_past_gideon.sql:59-82).
--
-- O histórico é **append-only por privilégio** (SD-C3-3/SD-C3-4): `app_runtime`
-- recebe apenas SELECT+INSERT em `ai_memory_versions` — sem UPDATE/DELETE, a
-- imutabilidade da versão "byte a byte" (aceite b, §34) não depende de
-- disciplina de código, e a supressão de uma versão só existe pelo expurgo
-- explícito (que exige um executor privilegiado, ver SD-C3-9).
--
-- O conflito tem SELECT+INSERT+UPDATE (SD-C3-6): o ciclo de vida
-- (`open → dismissed|resolved`) é do serviço; D3 só **registra** o conflito e
-- nunca sobrescreve o ativo (SD-C3-5). Nada é concedido a PUBLIC.
REVOKE ALL ON TABLE "ai_memory_versions" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_memory_conflicts" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ai_memory_versions" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE "ai_memory_conflicts" TO app_runtime;--> statement-breakpoint
ALTER TABLE "ai_memory_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_memory_conflicts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ai_memory_versions" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ai_memory_conflicts" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);