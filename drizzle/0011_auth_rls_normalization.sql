-- 0011 — Normalização do RLS das tabelas de autenticação (12ª migration; journal 12/12)
--
-- Classificação §27: SAFE — aditiva e idempotente, zero mudança de dados,
-- sem quebra de compatibilidade com o runtime publicado (a role de conexão
-- atual, neondb_owner, é imune por BYPASSRLS; app_runtime já detém os grants
-- DML desde 0001/0002 e passa a receber políticas explícitas).
--
-- Contexto: produção Neon observada em 2026-09-10 apresenta RLS habilitado sem
-- políticas em users/sessions/accounts/verifications/rate_limits (drift
-- out-of-band, presente em nenhuma migration 0000–0010). O estado violava
-- INV-012 (migrations reproduzíveis) e deixava as cinco tabelas em DENY-ALL
-- para qualquer role não-owner.
--
-- Alvo (§11.9 + INV-008/INV-010): estado de produção tornado canônico e
-- reproduzível; DENY-ALL resolvido com política única de serviço
-- (auth_service_access) para app_runtime — better-auth executa o ciclo completo
-- dessas tabelas (inclusive fluxos pré-autenticação como sign-in), de modo que
-- isolamento por tenant não se aplica a tabelas de identidade; o isolamento
-- entre usuários permanece na camada de serviço. Roles legadas com grants
-- (authenticated/anonymous) permanecem negadas por ausência de política.
--
-- Probes obrigatórios (CP-1) e evidência: docs/evidence/cp1-auth-rls-2026-09-10/.
-- Rollback: drizzle/rollback/0011_to_0010_down.sql (nunca executar
-- automaticamente; pós-tráfego o caminho de rollback é restore de snapshot).

DO $auth_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['users', 'sessions', 'accounts', 'verifications', 'rate_limits']
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = table_name
        AND c.relrowsecurity
    ) THEN
      EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    END IF;
  END LOOP;
END
$auth_rls$;
--> statement-breakpoint
DO $auth_rls_policies$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['users', 'sessions', 'accounts', 'verifications', 'rate_limits']
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_policy p
      JOIN pg_class c ON c.oid = p.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname = table_name
        AND p.polname = 'auth_service_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY auth_service_access ON public.%I FOR ALL TO app_runtime USING (true) WITH CHECK (true)',
        table_name
      );
    END IF;
  END LOOP;
END
$auth_rls_policies$;
