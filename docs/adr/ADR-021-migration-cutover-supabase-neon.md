# ADR-021 — Migração e cutover Supabase para PostgreSQL/Neon

- Status: aceita; execução remota pendente
- Data: 2026-08-12
- Escopo: migração única, reconciliação, cutover e rollback

## Contexto

O PostgreSQL no Neon será a fonte canônica. O Supabase não permanecerá no runtime e será usado somente como origem read-only do processo único de migração. O cutover precisa preservar UUIDs, credenciais importáveis, identidades Google, relações e valores financeiros sem criar dual-write.

## Decisão

1. O primeiro ensaio ocorre em Neon develop, nunca em produção.
2. A origem é acessada por conexão direta read-only ou backup autorizado, inclusive para `auth.users` e `auth.identities`.
3. Cada usuário importado recebe um tenant pessoal determinístico; registros legados mantêm UUIDs e passam a referenciar esse tenant.
4. Hashes bcrypt são importados; sessões não são importadas. Contas Google preservam a identidade, mas reautorizam o novo callback.
5. O importador é idempotente e inicia transação `REPEATABLE READ, READ ONLY` na origem. O destino executa dry run por padrão e só confirma com `MIGRATION_APPLY=true`.
6. A reconciliação cobre contagens, nulos, intervalos de timestamps, somas financeiras, órfãos e checksums amostrais por tabela.
7. O cutover segue manutenção/read-only, export final, importação, reconciliação, troca de secrets, smoke sem escrita e liberação controlada.
8. Antes da primeira escrita no Neon, a aplicação pode voltar ao runtime anterior. Depois disso, rollback usa snapshot/PITR do Neon; não haverá dual-write.
9. A origem permanece congelada por 14 dias. Desativação ou exclusão exige aprovação explícita.

## Gates

- diferença zero ou exceção documentada e aprovada na reconciliação;
- migrations, integração, RLS/cross-tenant, E2E e smoke verdes;
- nenhum import, SDK, variável ou token Supabase no código executável;
- credenciais segregadas por ambiente e ausentes do repositório;
- plano de manutenção, responsável pelo go/no-go e janela de observação registrados.

## Consequências

O processo privilegia consistência e auditabilidade sobre disponibilidade contínua. Sem URLs Neon, acesso read-only à origem e credenciais de integração não existe evidência de migração real, portanto a release `develop → main` permanece bloqueada.
