-- §43/§15.2 — memória persistente (alvo M-05, degrau D2). As tabelas novas usam
-- os nomes do plano (`ai_*`); a implementação vigente de conversas permanece
-- `chat_conversations`/`chat_messages` (decisão A do STEWARD de 2026-09-16:
-- alias canônico, sem renomeação de tabela em uso) e as FKs de proveniência
-- apontam para essas tabelas vivas.
CREATE TABLE "ai_memories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"scope" text NOT NULL,
	"content" text NOT NULL,
	"importance" double precision DEFAULT 0 NOT NULL,
	"confidence" double precision,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_memories_tenant_id_id_uidx" UNIQUE("tenant_id","id"),
	CONSTRAINT "ai_memories_scope_check" CHECK ("ai_memories"."scope" in ('tenant', 'user', 'conversation')),
	CONSTRAINT "ai_memories_content_check" CHECK ("ai_memories"."content" <> ''),
	CONSTRAINT "ai_memories_status_check" CHECK ("ai_memories"."status" in ('active', 'superseded')),
	CONSTRAINT "ai_memories_importance_check" CHECK ("ai_memories"."importance" >= 0 and "ai_memories"."importance" <= 1),
	CONSTRAINT "ai_memories_confidence_check" CHECK ("ai_memories"."confidence" is null or ("ai_memories"."confidence" >= 0 and "ai_memories"."confidence" <= 1))
);
--> statement-breakpoint
CREATE TABLE "ai_memory_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"memory_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text,
	"conversation_id" uuid,
	"message_id" uuid,
	"product_id" uuid,
	"simulation_id" uuid,
	"user_id" text,
	"inferred" boolean DEFAULT false NOT NULL,
	"confidence" double precision NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_memory_sources_kind_check" CHECK ("ai_memory_sources"."source_kind" in ('user', 'tool', 'model', 'import')),
	CONSTRAINT "ai_memory_sources_confidence_check" CHECK ("ai_memory_sources"."confidence" >= 0 and "ai_memory_sources"."confidence" <= 1),
	CONSTRAINT "ai_memory_sources_ref_check" CHECK ("ai_memory_sources"."source_ref" is null or "ai_memory_sources"."source_ref" <> ''),
	CONSTRAINT "ai_memory_sources_origin_check" CHECK ("ai_memory_sources"."source_ref" is not null or "ai_memory_sources"."conversation_id" is not null or "ai_memory_sources"."message_id" is not null or "ai_memory_sources"."product_id" is not null or "ai_memory_sources"."simulation_id" is not null or "ai_memory_sources"."user_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_sources" ADD CONSTRAINT "ai_memory_sources_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_sources" ADD CONSTRAINT "ai_memory_sources_tenant_id_memory_id_ai_memories_tenant_id_id_fk" FOREIGN KEY ("tenant_id","memory_id") REFERENCES "public"."ai_memories"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_sources" ADD CONSTRAINT "ai_memory_sources_tenant_id_conversation_id_chat_conversations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."chat_conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_sources" ADD CONSTRAINT "ai_memory_sources_tenant_id_message_id_chat_messages_tenant_id_id_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."chat_messages"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_sources" ADD CONSTRAINT "ai_memory_sources_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_sources" ADD CONSTRAINT "ai_memory_sources_tenant_id_simulation_id_simulations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","simulation_id") REFERENCES "public"."simulations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_memory_sources" ADD CONSTRAINT "ai_memory_sources_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_memories_tenant_status_created_idx" ON "ai_memories" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ai_memory_sources_tenant_memory_idx" ON "ai_memory_sources" USING btree ("tenant_id","memory_id");
;--> statement-breakpoint
-- §43/§15.8: grants mínimos e RLS fail-closed por tenant, no padrão de
-- `outbox_events` (drizzle/0015_curved_riptide.sql:38-57). A memória precisa de
-- SELECT (retrieval), INSERT (append), UPDATE (ciclo de vida — D3) e DELETE
-- (§43 exige eliminação); a proveniência é append-only e cai pela cascata da
-- memória, então não recebe DELETE próprio. Nada é concedido a PUBLIC.
REVOKE ALL ON TABLE "ai_memories" FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON TABLE "ai_memory_sources" FROM PUBLIC;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "ai_memories" TO app_runtime;--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "ai_memory_sources" TO app_runtime;--> statement-breakpoint
ALTER TABLE "ai_memories" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_memory_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ai_memories" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);--> statement-breakpoint
CREATE POLICY tenant_isolation ON "ai_memory_sources" TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);
