-- ARQUIVO HISTÓRICO: origem legada read-only; não participa do runtime.
-- FIN-002 (Lote 04): valores financeiros desconhecidos devem permanecer NULL.
-- Rollout: publique primeiro a aplicação que grava NULL explicitamente em novos
-- produtos; só então aplique esta migration que remove os defaults legados.
-- Não reescrevemos linhas existentes com 1/0 porque não há proveniência segura
-- para distinguir um valor confirmado do default legado.
-- Operação histórica pendente: antes de importar dados/abrir produção,
-- marcar 1/0 históricos como não verificados e exigir reconfirmação.
ALTER TABLE public.products
  ALTER COLUMN yield_qty DROP DEFAULT,
  ALTER COLUMN tax_rate DROP DEFAULT;
