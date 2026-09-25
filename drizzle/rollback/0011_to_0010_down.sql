-- Rollback 0011 → 0010: desfaz a normalização do RLS das tabelas de autenticação.
--
-- ATENÇÃO (disciplina da guard 0010): executar automaticamente é PROIBIDO.
-- Pós-tráfego, o caminho de rollback é restore de snapshot nativo (BAK-01),
-- não reexecução de down. Este arquivo existe para rebase de ambientes de
-- laboratório e para reprodução do estado pré-0011 (RLS habilitado sem
-- políticas — o drift observado em produção em 2026-09-10).
--
-- Pré-requisitos: nenhuma sessão como app_runtime dependendo das políticas
-- auth_service_access; reconciliation do journal (11 entradas) após o down.
--
-- O down remove APENAS a política; o RLS permanece habilitado — é exatamente o
-- estado pré-0011 de produção (RLS ligado, sem políticas) que a migration veio
-- normalizar. Em banco canônico de laboratório (RLS desligado antes da 0011) o
-- state pós-down difere do estado 0010 puro; por isso não há rollback
-- automático: pós-tráfego o caminho é restore de snapshot.

DO $auth_rls_down$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['users', 'sessions', 'accounts', 'verifications', 'rate_limits']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS auth_service_access ON public.%I', table_name);
  END LOOP;
END
$auth_rls_down$;
