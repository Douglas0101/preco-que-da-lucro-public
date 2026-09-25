CREATE TABLE "ai_memory_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"memory_id" uuid,
	"result" text NOT NULL,
	"row_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_memory_access_log_action_check" CHECK ("ai_memory_access_log"."action" in ('access', 'delete', 'export')),
	CONSTRAINT "ai_memory_access_log_result_check" CHECK ("ai_memory_access_log"."result" in ('allowed', 'not_found', 'refused')),
	CONSTRAINT "ai_memory_access_log_row_count_check" CHECK ("ai_memory_access_log"."row_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ai_memory_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"layer" text NOT NULL,
	"version" integer NOT NULL,
	"ttl_seconds" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_memory_policies_layer_version_uidx" UNIQUE("layer","version"),
	CONSTRAINT "ai_memory_policies_layer_check" CHECK ("ai_memory_policies"."layer" in ('L1', 'L2', 'L3', 'L4', 'L5')),
	CONSTRAINT "ai_memory_policies_version_check" CHECK ("ai_memory_policies"."version" > 0),
	CONSTRAINT "ai_memory_policies_ttl_check" CHECK ("ai_memory_policies"."ttl_seconds" is null or "ai_memory_policies"."ttl_seconds" > 0)
);
--> statement-breakpoint
ALTER TABLE "ai_memories" DROP CONSTRAINT "ai_memories_status_check";--> statement-breakpoint
ALTER TABLE "ai_memories" ADD COLUMN "layer" text DEFAULT 'L2' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_memory_access_log" ADD CONSTRAINT "ai_memory_access_log_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_memory_access_log_tenant_action_created_idx" ON "ai_memory_access_log" USING btree ("tenant_id","action","created_at");--> statement-breakpoint
CREATE INDEX "ai_memory_access_log_tenant_memory_idx" ON "ai_memory_access_log" USING btree ("tenant_id","memory_id");--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_layer_check" CHECK ("ai_memories"."layer" in ('L1', 'L2', 'L3', 'L4', 'L5'));--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_status_check" CHECK ("ai_memories"."status" in ('active', 'superseded', 'expired'));--> statement-breakpoint
-- §43/§15.4/§15.8 — grants mínimos e RLS fail-closed no molde de
-- `ai_memories`/`ai_memory_sources` (0017) e `ai_memory_versions` (0018).
--
-- A trilha de auditoria é **append-only por privilégio**: `app_runtime` recebe
-- só SELECT+INSERT — sem UPDATE/DELETE, o log de acesso/delete/export não se
-- reescreve nem se apaga pelo caminho da aplicação. Nada é concedido a PUBLIC.
REVOKE ALL ON TABLE "ai_memory_access_log" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ai_memory_access_log" TO app_runtime;--> statement-breakpoint
ALTER TABLE "ai_memory_access_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ai_memory_access_log" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);--> statement-breakpoint
-- SD-C3-12 (fechada em D4): o expurgo LGPD passa a ser executável pela role de
-- aplicação. A imutabilidade do histórico continua enforçada por privilégio,
-- mas pela **negação do `UPDATE`** (reescrever história segue impossível); o
-- `DELETE` passa a ser permitido porque a eliminação tem de rodar pela role da
-- aplicação — e as FKs seguem `RESTRICT`, de modo que o expurgo precisa apagar
-- filho→pai explicitamente (falha alta em vez de levar histórico em silêncio).
GRANT DELETE ON TABLE "ai_memory_versions" TO app_runtime;--> statement-breakpoint
GRANT DELETE ON TABLE "ai_memory_conflicts" TO app_runtime;--> statement-breakpoint
-- `ai_memory_policies` é **global**: retenção é política do sistema (§15.1/L5),
-- não do tenant — sem `tenant_id` não há RLS por tenant, como `rum_vitals`
-- (0014). Grant SELECT+INSERT: publicar política nova é INSERT de versão maior,
-- nunca UPDATE/DELETE (reverter é republicar a versão anterior, §H-12 rollback).
REVOKE ALL ON TABLE "ai_memory_policies" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ai_memory_policies" TO app_runtime;--> statement-breakpoint
-- Defaults aprovados no H-12 (opção A) como **linhas versionadas** — nenhum TTL
-- em constante de código nem em SQL de consulta: L1 30 d, L2 180 d, L3 365 d,
-- L4 acompanha a entidade referenciada (sem TTL de relógio) e L5 sem TTL
-- (versionada). `ON CONFLICT DO NOTHING` torna o seed idempotente.
INSERT INTO "ai_memory_policies" ("layer", "version", "ttl_seconds") VALUES
  ('L1', 1, 2592000),
  ('L2', 1, 15552000),
  ('L3', 1, 31536000),
  ('L4', 1, NULL),
  ('L5', 1, NULL)
ON CONFLICT ("layer", "version") DO NOTHING;
