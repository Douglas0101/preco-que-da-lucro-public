-- Rollback 0016 → 0015: remove o ledger de backfill (§28.2 checkpoint + §28.4
-- marcador de idempotência).
--
-- DDL reversível e aditivo: as duas tabelas são criadas por 0016, sem
-- dependentes externos. O down descarta o progresso de backfills em curso, então
-- o rollback pós-tráfego exige concluir (ou parar) os runs antes, e o caminho
-- canônico é restore de snapshot; este arquivo existe para rebase de ambientes
-- de laboratório e para o chain de teste (scripts/db/test-migrations.ts).
DROP POLICY IF EXISTS tenant_isolation ON "backfill_checkpoints";
DROP POLICY IF EXISTS tenant_isolation ON "backfill_work_items";
REVOKE ALL ON TABLE "backfill_checkpoints" FROM app_runtime;
REVOKE ALL ON TABLE "backfill_work_items" FROM app_runtime;
-- Nenhuma FK entre as duas: `run_key` do marcador é rastreabilidade, não
-- referência ao checkpoint (a tentativa pode nem ter fechado um lote).
DROP TABLE IF EXISTS "backfill_checkpoints";
DROP TABLE IF EXISTS "backfill_work_items";
