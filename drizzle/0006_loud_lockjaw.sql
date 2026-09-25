CREATE TABLE "ai_usage" (
	"usage_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"round_no" integer DEFAULT 0 NOT NULL,
	"budget_tokens" integer NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"reserved_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"real_tokens" integer,
	"outcome" text,
	CONSTRAINT "ai_usage_status_check" CHECK ("ai_usage"."status" in ('reserved', 'settled', 'expired')),
	CONSTRAINT "ai_usage_round_no_check" CHECK ("ai_usage"."round_no" >= 0),
	CONSTRAINT "ai_usage_budget_tokens_check" CHECK ("ai_usage"."budget_tokens" >= 0),
	CONSTRAINT "ai_usage_real_tokens_check" CHECK ("ai_usage"."real_tokens" is null or "ai_usage"."real_tokens" >= 0)
);
--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" DROP CONSTRAINT "ai_daily_budgets_nonnegative_check";--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" ADD COLUMN "tokens_reserved" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" ADD COLUMN "in_flight" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_tenant_status_reserved_idx" ON "ai_usage" USING btree ("tenant_id","status","reserved_at");--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" ADD CONSTRAINT "ai_daily_budgets_nonnegative_check" CHECK ("ai_daily_budgets"."chat_count" >= 0 and "ai_daily_budgets"."model_call_count" >= 0 and "ai_daily_budgets"."tool_call_count" >= 0 and "ai_daily_budgets"."input_tokens" >= 0 and "ai_daily_budgets"."output_tokens" >= 0 and "ai_daily_budgets"."tokens_reserved" >= 0 and "ai_daily_budgets"."in_flight" >= 0 and "ai_daily_budgets"."estimated_cost" >= 0);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE ai_usage TO app_runtime;
--> statement-breakpoint
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON ai_usage TO app_runtime USING (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
) WITH CHECK (
  tenant_id = app_private.current_tenant_id()
  AND app_private.has_tenant_access(tenant_id)
);
