-- Rollback 0019 → 0018: remove o degrau D4 (TTL por camada + trilha de
-- auditoria) e a extensão de estado `expired` de `ai_memories`.
--
-- Diferente do down de 0018 (que só fecha com `ai_memories` vazia), este down é
-- **executável com dados**: `layer` tem DEFAULT (`'L2'`) no re-add, `expires_at`
-- é nullable e o seed de policies é idempotente (`ON CONFLICT DO NOTHING`). O
-- que ele **descarta** é a informação de retenção (`expires_at`, `layer` por
-- camada) e a trilha de auditoria já gravada — logo, pós-tráfego, a decisão
-- sobre esse rastro (§48) e o caminho canônico (restore de snapshot) continuam
-- valendo. Ele existe para rebase de ambiente de laboratório e para o chain de
-- teste (`scripts/db/test-migrations.ts`).
--
-- Ordem: políticas/trilha → grants → colunas → vocabulário de estados. A
-- restauração do CHECK antigo exige que nenhuma linha esteja em `expired`:
-- expirar era só a coluna `expires_at` (dropada aqui), então a linha volta a
-- `active` — sem a coluna de validade a marcação `expired` não é representável
-- no vocabulário anterior, e deixá-la prenderia o down.
DROP POLICY IF EXISTS tenant_isolation ON "ai_memory_access_log";
REVOKE ALL ON TABLE "ai_memory_access_log" FROM app_runtime;
DROP TABLE IF EXISTS "ai_memory_access_log";
REVOKE ALL ON TABLE "ai_memory_policies" FROM app_runtime;
DROP TABLE IF EXISTS "ai_memory_policies";
REVOKE DELETE ON TABLE "ai_memory_versions" FROM app_runtime;
REVOKE DELETE ON TABLE "ai_memory_conflicts" FROM app_runtime;
UPDATE "ai_memories" SET "status" = 'active' WHERE "status" = 'expired';
ALTER TABLE "ai_memories" DROP CONSTRAINT IF EXISTS "ai_memories_status_check";
ALTER TABLE "ai_memories" DROP CONSTRAINT IF EXISTS "ai_memories_layer_check";
ALTER TABLE "ai_memories" DROP COLUMN IF EXISTS "expires_at";
ALTER TABLE "ai_memories" DROP COLUMN IF EXISTS "layer";
ALTER TABLE "ai_memories" ADD CONSTRAINT "ai_memories_status_check"
  CHECK ("ai_memories"."status" in ('active', 'superseded'));
