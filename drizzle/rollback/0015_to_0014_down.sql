-- Rollback 0015 → 0014: remove o outbox transacional (§23) e a inbox do
-- consumidor (23.2).
--
-- DDL reversível e aditivo: as duas tabelas são criadas por 0015, sem
-- dependentes externos. O down descarta os eventos ainda não drenados, então o
-- rollback pós-tráfego exige drenar a fila antes (ou aceitar a perda) e o
-- caminho canônico é restore de snapshot; este arquivo existe para rebase de
-- ambientes de laboratório e para o chain de teste (scripts/db/test-migrations.ts).
DROP POLICY IF EXISTS tenant_isolation ON "outbox_consumptions";
DROP POLICY IF EXISTS tenant_isolation ON "outbox_events";
REVOKE ALL ON TABLE "outbox_consumptions" FROM app_runtime;
REVOKE ALL ON TABLE "outbox_events" FROM app_runtime;
-- A inbox referencia outbox_events; o filho cai primeiro.
DROP TABLE IF EXISTS "outbox_consumptions";
DROP TABLE IF EXISTS "outbox_events";
