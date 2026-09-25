ALTER TABLE "tool_executions" ADD COLUMN "tool_call_id" text;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD COLUMN "input" jsonb;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD COLUMN "usage_id" uuid;--> statement-breakpoint
CREATE INDEX "tool_executions_tenant_usage_idx" ON "tool_executions" USING btree ("tenant_id","usage_id");