-- Down restores the pre-backfill state (NULL issuer on credential accounts).
-- WARNING: running this while better-auth >= 1.7.x is deployed breaks sign-in.
--
-- GUARDA RECALIBRADA (2026-09-05, rodada pré-A4 / DB-01):
-- O predicado anterior referenciava as 4 contas de fixture então presentes.
-- Após o purge DB-01, production é fixture-free e TODA conta existente é
-- tráfego real. O down abaixo anularia o issuer dessas contas e quebraria o
-- sign-in (better-auth 1.7.x exige issuer) — portanto o guarda falha fechado
-- quando há qualquer conta, e o caminho de rollback de issuer pós-tráfego é
-- RESTORE do snapshot pré-deploy (política BAK-01), nunca este arquivo.
--
-- A guarda e o down rodam numa ÚNICA transação: sem isso, psql em autocommit
-- executaria o UPDATE mesmo após o RAISE (re-drill 2026-09-06: exceção seguida
-- de "UPDATE 4" — guarda cosmética sem tx única).
--
-- PROIBIDO executar automaticamente. Pré-requisitos antes de qualquer down:
--   1. reconciliar as linhas efetivamente alteradas pelo forward no ambiente
--      alvo (esperado: zero) e documentar a contagem;
--   2. confirmar a versão de better-auth atendendo tráfego (1.6.x aceita
--      issuer NULL; 1.7.x NÃO aceita);
--   3. registrar a execução no ledger com reconciliation report (§13.4/13.5).
-- Para reverter apenas o artefato da aplicação (código), preferir rollback de
-- deploy sem este down — as mudanças 0008/0009/0010 são 100% aditivas.
BEGIN;

DO $$
DECLARE
  account_count int;
BEGIN
  SELECT count(*) INTO account_count FROM "accounts";
  IF account_count > 0 THEN
    RAISE EXCEPTION
      'rollback 0010 BLOQUEADO: % conta(s) presentes. Após o purge DB-01 toda conta é tráfego real; rollback de issuer somente via restore de snapshot (BAK-01).',
      account_count;
  END IF;
END
$$;

UPDATE "accounts" SET "issuer" = NULL
WHERE "provider_id" = 'credential' AND "issuer" = 'local:credential';

COMMIT;

