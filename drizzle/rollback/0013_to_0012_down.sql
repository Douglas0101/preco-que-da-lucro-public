-- Rollback 0013 → 0012: remove o version otimista (T2) de products e expenses.
-- As colunas são aditivas com default constante e os CHECKs só validam o próprio
-- valor; o down é destrutivo apenas para o contador que só a 0013 mantém — nenhum
-- dado de negócio é perdido. Pós-tráfego o caminho canônico de rollback é restore
-- de snapshot; este arquivo existe para rebase de ambientes de laboratório e para
-- o chain de teste (scripts/db/test-migrations.ts).
ALTER TABLE "products" DROP CONSTRAINT IF EXISTS "products_version_check";--> statement-breakpoint
ALTER TABLE "products" DROP COLUMN IF EXISTS "version";--> statement-breakpoint
ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "expenses_version_check";--> statement-breakpoint
ALTER TABLE "expenses" DROP COLUMN IF EXISTS "version";
