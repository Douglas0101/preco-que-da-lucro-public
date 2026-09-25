-- Rollback 0014 → 0013: remove a série de RUM (rum_vitals).
-- A tabela é criada por 0014, sem dependentes e com dados de telemetria
-- descartáveis; o down é destrutivo apenas para a própria série. Pós-tráfego o
-- caminho canônico de rollback é restore de snapshot; este arquivo existe para
-- rebase de ambientes de laboratório e para o chain de teste
-- (scripts/db/test-migrations.ts).
DROP TABLE IF EXISTS "rum_vitals";
