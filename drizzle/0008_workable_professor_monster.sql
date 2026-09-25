ALTER TABLE "ai_daily_budgets" DROP CONSTRAINT "ai_daily_budgets_nonnegative_check";--> statement-breakpoint
ALTER TABLE "calculation_snapshots" ALTER COLUMN "entity_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" ADD COLUMN "estimated_cost_unknown_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "estimated_cost" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "ai_usage" ADD COLUMN "cost_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "calculation_snapshots" ADD COLUMN "idempotency_key" text DEFAULT gen_random_uuid()::text NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "conversation_state" text DEFAULT 'idle' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "state_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "state_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD COLUMN "estimated_cost" numeric(19, 4);--> statement-breakpoint
ALTER TABLE "tool_executions" ADD COLUMN "cost_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "calculation_snapshots_idempotency_uidx" ON "calculation_snapshots" USING btree ("tenant_id","calculation_type","idempotency_key");--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" ADD CONSTRAINT "ai_daily_budgets_nonnegative_check" CHECK ("ai_daily_budgets"."chat_count" >= 0 and "ai_daily_budgets"."model_call_count" >= 0 and "ai_daily_budgets"."tool_call_count" >= 0 and "ai_daily_budgets"."input_tokens" >= 0 and "ai_daily_budgets"."output_tokens" >= 0 and "ai_daily_budgets"."tokens_reserved" >= 0 and "ai_daily_budgets"."in_flight" >= 0 and "ai_daily_budgets"."estimated_cost" >= 0 and "ai_daily_budgets"."estimated_cost_unknown_count" >= 0);--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_cost_status_check" CHECK ("ai_usage"."cost_status" in ('known', 'unknown', 'invalid'));--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_state_check" CHECK ("chat_conversations"."conversation_state" in ('idle', 'collecting_context', 'calculating', 'confirming', 'executing', 'completed', 'failed'));--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_cost_status_check" CHECK ("tool_executions"."cost_status" in ('known', 'unknown', 'invalid'));