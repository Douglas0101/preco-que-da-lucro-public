ALTER TABLE "ai_daily_budgets" ADD COLUMN "tool_call_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" DROP CONSTRAINT "ai_daily_budgets_nonnegative_check";--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" ADD CONSTRAINT "ai_daily_budgets_nonnegative_check" CHECK ("ai_daily_budgets"."chat_count" >= 0 and "ai_daily_budgets"."model_call_count" >= 0 and "ai_daily_budgets"."tool_call_count" >= 0 and "ai_daily_budgets"."input_tokens" >= 0 and "ai_daily_budgets"."output_tokens" >= 0 and "ai_daily_budgets"."estimated_cost" >= 0);
