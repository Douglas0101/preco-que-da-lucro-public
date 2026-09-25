-- Rollback 0018 → 0017: remove o dedup/versionamento/conflitos da memória
-- (§15.6/D3 — `ai_memory_versions` + `ai_memory_conflicts` + a coluna
-- `ai_memories.dedup_key` e o índice único parcial do dedup).
--
-- **Use este down somente ANTES de tráfego** (`ai_memories` vazia). O par
-- up→down→up só fecha nessa condição: o up de 0018 é
-- `ALTER TABLE "ai_memories" ADD COLUMN "dedup_key" text NOT NULL` **sem
-- default e sem backfill** (a tabela não tinha escritor quando a migration foi
-- escrita — SD-C3-2), então basta **uma linha pré-existente** para o 2º up
-- falhar com `column "dedup_key" of relation "ai_memories" contains null
-- values`, deixando o banco preso em 0017 — com o histórico e os conflitos já
-- destruídos por este down (`DROP TABLE`).
--
-- **Pós-tráfego, faça restore de snapshot — não reaplique este par.** Reaplicar
-- 0018 com dados exige um **backfill de `dedup_key`** que este downgrade não tem
-- como reconstruir: a chave é
-- `sha256(scope ‖ 0x1f ‖ discriminador ‖ 0x1f ‖ conteúdo normalizado)` e a
-- normalização (NFC + remoção da categoria `Cf` + `trim` + colapso de espaços)
-- vive no TypeScript do repositório; o down descarta a coluna sem guardar cópia
-- das chaves e o SQL da migration não expressa aquela normalização (nem o
-- discriminador de conversa, que vem da fonte primária). Se o backfill for
-- realmente necessário, trate-o como job explícito — não como migration.
--
-- DDL reversível e aditivo: as duas tabelas são criadas por 0018 e a FK
-- composta delas para `ai_memories` é ON DELETE RESTRICT (o filho precisa cair
-- antes do pai). O down descarta o histórico e os conflitos já registrados,
-- então o rollback pós-tráfego exige decisão explícita sobre esse dado pessoal
-- (§48) e o caminho canônico é restore de snapshot; este arquivo existe para
-- rebase de ambientes de laboratório e para o chain de teste
-- (`scripts/db/test-migrations.ts`).
--
-- `dedup_key` é DROPada por último: sem o índice único parcial, a coluna não
-- tem dependentes. O down é destrutivo para o dado de dedup (recomputável a
-- partir de `scope`/`user_id`/proveniência/conteúdo) — não há backfill no up
-- porque a tabela não tinha escritor antes de D3 (SD-C3-2).
DROP POLICY IF EXISTS tenant_isolation ON "ai_memory_conflicts";
DROP POLICY IF EXISTS tenant_isolation ON "ai_memory_versions";
REVOKE ALL ON TABLE "ai_memory_conflicts" FROM app_runtime;
REVOKE ALL ON TABLE "ai_memory_versions" FROM app_runtime;
DROP TABLE IF EXISTS "ai_memory_conflicts";
DROP TABLE IF EXISTS "ai_memory_versions";
DROP INDEX IF EXISTS "ai_memories_tenant_dedup_key_active_uidx";
ALTER TABLE "ai_memories" DROP COLUMN IF EXISTS "dedup_key";
