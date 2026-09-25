-- Rollback 0017 → 0016: remove a persistência da memória (§43/D2 —
-- `ai_memories` + proveniência 1:N `ai_memory_sources`).
--
-- DDL reversível e aditivo: as duas tabelas são criadas por 0017, sem
-- dependentes fora do par (a ordem importa: a fonte referencia a memória).
-- O down descarta as memórias já gravadas, então o rollback pós-tráfego exige
-- decisão explícita sobre esse dado pessoal (§48) e o caminho canônico é restore
-- de snapshot; este arquivo existe para rebase de ambientes de laboratório e
-- para o chain de teste (`scripts/db/test-migrations.ts`).
DROP POLICY IF EXISTS tenant_isolation ON "ai_memory_sources";
DROP POLICY IF EXISTS tenant_isolation ON "ai_memories";
REVOKE ALL ON TABLE "ai_memory_sources" FROM app_runtime;
REVOKE ALL ON TABLE "ai_memories" FROM app_runtime;
DROP TABLE IF EXISTS "ai_memory_sources";
DROP TABLE IF EXISTS "ai_memories";
