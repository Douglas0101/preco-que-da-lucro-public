-- Rollback 0012 → 0011: remove o vínculo tool_executions ↔ ai_usage e o
-- payload de input. As três colunas são aditivas e nullable — o down é
-- destrutivo apenas para os dados que só a 0012 grava (tool_call_id, input,
-- usage_id), que não existem no estado pré-0012. O índice
-- tool_executions_tenant_usage_idx cai junto com a coluna usage_id.
--
-- Pós-tráfego o caminho canônico de rollback é restore de snapshot; este
-- arquivo existe para rebase de ambientes de laboratório e para o chain de
-- teste 0011→0003 (scripts/db/test-migrations.ts).

ALTER TABLE "tool_executions" DROP COLUMN IF EXISTS "tool_call_id";--> statement-breakpoint
ALTER TABLE "tool_executions" DROP COLUMN IF EXISTS "input";--> statement-breakpoint
ALTER TABLE "tool_executions" DROP COLUMN IF EXISTS "usage_id";
