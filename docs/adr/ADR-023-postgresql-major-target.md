# ADR-023 — Major PostgreSQL alvo para CI e Neon

- Status: aceito
- Data: 2026-08-15
- Escopo: desenvolvimento local, branches Neon e readiness de migração

## Contexto

O CI executa PostgreSQL 17 e as migrations, testes de RLS e contratos de
privilégio são reproduzidos nesse major. O Neon pode oferecer PostgreSQL 18
como default, mas a novidade do provedor não constitui evidência de
compatibilidade do produto.

## Decisão

1. PostgreSQL 17 é o major fixado para o CI e para o projeto Neon alvo.
2. O workflow `db:test` falha quando `server_version_num` não corresponde ao
   major esperado (`EXPECTED_POSTGRES_MAJOR`, default 17).
3. A branch `develop` do Neon deverá ser criada em PostgreSQL 17; branches de
   preview herdam esse major.
4. PostgreSQL 18 não será adotado automaticamente. Uma mudança exige ADR
   posterior, matriz de compatibilidade 17/18, migrations do zero e sobre
   schema existente, testes RLS/privileges, smoke, performance e rollback.
5. A decisão não altera os contratos de conexão: `DATABASE_URL` permanece
   pooled para runtime e `DATABASE_ADMIN_URL` permanece direct para migration
   e administração.

## Consequências

- O CI detecta drift de major antes de considerar a validação do banco verde.
- O provisionamento Neon deve selecionar explicitamente PostgreSQL 17.
- O projeto aceita a estabilidade do major atual em troca de não acompanhar o
  default do provedor sem evidência.
- A prova local/CI não substitui a criação do projeto Neon, a branch real, o
  backup/restore ou o cutover.

## Referências

- ADR-019 — PostgreSQL no Neon, Drizzle e isolamento por tenant.
- Plano Mestre, §12.1 e §42.
- `scripts/db/test-migrations.ts` e `EXPECTED_POSTGRES_MAJOR`.

## Addendum 2026-09-08 — §12.1 (E5)

Major vigente: **PG 17** (Neon `damp-forest-57346541`, CI `EXPECTED_POSTGRES_MAJOR=17`,
`postgres:17-alpine` local). **PG 18 RECUSADO** sem novo ADR + matriz de
compatibilidade 17/18 (extensões, driver, migration tool, ambiente, rollback),
conforme Decisão 4 acima. Este addendum fecha o GAP-DOC pendente de §12.1 e é
a âncora citada pela emenda de reconstrução (`emenda-2026-09-08-42-13-reconstrucao.md`).
