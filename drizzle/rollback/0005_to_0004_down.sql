ALTER TABLE "ai_daily_budgets" DROP CONSTRAINT "ai_daily_budgets_nonnegative_check";
ALTER TABLE "ai_daily_budgets" ADD CONSTRAINT "ai_daily_budgets_nonnegative_check" CHECK ("ai_daily_budgets"."chat_count" >= 0 and "ai_daily_budgets"."model_call_count" >= 0 and "ai_daily_budgets"."input_tokens" >= 0 and "ai_daily_budgets"."output_tokens" >= 0 and "ai_daily_budgets"."estimated_cost" >= 0);
ALTER TABLE "ai_daily_budgets" DROP COLUMN "tool_call_count";
