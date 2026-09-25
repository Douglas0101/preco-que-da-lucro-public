# ADR-019 — PostgreSQL no Neon, Drizzle e isolamento por tenant

- Status: aceito
- Data: 2026-08-12
- Escopo: persistência canônica do P0

## Contexto

O runtime legado usa clientes Supabase no navegador e no servidor. O P0 exige uma fronteira BFF server-driven, PostgreSQL canônico, isolamento por tenant e migrações reproduzíveis sem dependência final de Supabase.

## Decisão

1. O PostgreSQL hospedado inicialmente no Neon é a fonte canônica.
2. O runtime usa Drizzle com `@neondatabase/serverless` e `DATABASE_URL` pooled.
3. Migrações e administração usam `DATABASE_ADMIN_URL` direct. Nenhuma das URLs é exposta por variável `VITE_*`.
4. Valores monetários são `NUMERIC(19,4)`, intermediários/contextos de conversão usam `NUMERIC(24,8)`, percentuais são frações em `NUMERIC(9,6)` e quantidades usam `NUMERIC(24,6)`.
5. IDs legados são preservados. Cada usuário importado recebe um tenant pessoal e os registros existentes recebem `tenant_id` sem trocar seus UUIDs.
6. Tabelas tenant-scoped têm `tenant_id` explícito, FKs compostas e RLS. Queries de repository também devem filtrar `tenant_id`; RLS é a segunda barreira, não substitui o filtro.
7. Cada operação tenant-scoped executa em transação curta e define `app.current_user_id`, `app.current_tenant_id` e `app.current_roles` com `set_config(..., true)`.
8. `app_runtime` é uma role `LOGIN`, não-owner, sem `SUPERUSER`, `CREATEDB`, `CREATEROLE` ou `BYPASSRLS`. A senha é provisionada fora do repositório.
9. As tabelas internas do Better Auth não têm RLS tenant-scoped: elas são acessíveis apenas pelo BFF através da role runtime e nunca são expostas como API de dados.
10. O CI sempre valida migrations em PostgreSQL 17 efêmero. Quando `NEON_API_KEY` e `NEON_PROJECT_ID` existirem, o workflow também cria uma branch Neon por execução de PR e a remove em `always()`.

## Consultas e índices

Os índices seguem os acessos já existentes: listagens por tenant e criação, detalhes filhos por `(tenant_id, product_id)`, conversa por `(tenant_id, conversation_id, created_at)`, sessões por token/usuário/expiração, auditoria por tenant/data ou correlation ID e idempotência por escopo completo.

## Migração e compatibilidade

O runtime Supabase permanece temporariamente intacto até o dry run reconciliado no Neon develop. Supabase será apenas a origem read-only do export único; não haverá dual-write. O cutover e a remoção dos clientes/variáveis legados pertencem a um lote posterior.

## Consequências

- A aplicação precisa receber uma identidade confiável antes de abrir a transação tenant-scoped.
- Conexões administrativas não podem ser usadas pelo runtime.
- Alterações de schema passam a exigir migration, teste de zero, rollback e isolamento.
- Sem credenciais externas, a prova local/CI usa PostgreSQL efêmero; a prova Neon é ativada automaticamente quando os secrets forem configurados.

## Major PostgreSQL

O major alvo e o critério de compatibilidade do PostgreSQL estão registrados em
[ADR-023](ADR-023-postgresql-major-target.md). A decisão atual fixa PostgreSQL
17; este ADR continua sendo a referência para conexão, isolamento e role de
runtime.
