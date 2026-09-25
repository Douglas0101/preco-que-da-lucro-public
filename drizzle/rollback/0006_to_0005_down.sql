DROP POLICY IF EXISTS tenant_isolation ON public.ai_usage;
ALTER TABLE public.ai_usage DISABLE ROW LEVEL SECURITY;
REVOKE SELECT, INSERT, UPDATE ON TABLE public.ai_usage FROM app_runtime;
DROP INDEX IF EXISTS public.ai_usage_tenant_status_reserved_idx;
DROP TABLE IF EXISTS public.ai_usage CASCADE;

ALTER TABLE public.ai_daily_budgets DROP CONSTRAINT "ai_daily_budgets_nonnegative_check";
ALTER TABLE public.ai_daily_budgets ADD CONSTRAINT "ai_daily_budgets_nonnegative_check"
  CHECK (chat_count >= 0 and model_call_count >= 0 and tool_call_count >= 0
    and input_tokens >= 0 and output_tokens >= 0 and estimated_cost >= 0);
ALTER TABLE public.ai_daily_budgets
  DROP COLUMN IF EXISTS tokens_reserved,
  DROP COLUMN IF EXISTS in_flight;
