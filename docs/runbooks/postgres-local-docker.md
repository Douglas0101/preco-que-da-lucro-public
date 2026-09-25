# Runbook — PostgreSQL local via Docker

Espelha o serviço `postgres:17-alpine` do job `verify` (`.github/workflows/ui-stack.yml`)
para desenvolvimento local sem Neon. A major é fixada pelo ADR-023 e verificada
pelo `db:test` via `EXPECTED_POSTGRES_MAJOR` (default 17).

## Subir e derrubar

```bash
npm run db:up    # docker compose up -d --wait (aguarda healthy)
npm run db:down  # docker compose down
```

Container `preco-que-da-lucro-postgres`, porta `5432`, banco
`preco_que_da_lucro_test`, usuário/senha `postgres`/`postgres`, volume nomeado
`postgres-data` (persiste entre `db:down`).

## Rodar migrations e contratos

```bash
export DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/preco_que_da_lucro_test
export DATABASE_ADMIN_URL=$DATABASE_URL
export DATABASE_DRIVER=node-postgres
npm run db:test
```

O `db:test` é autocontido: roda as migrations do zero, valida constraints,
grants, RLS, tabelas P1, trigger deferred de vendas, rollback + replay e os
testes de auth/ferramentas/chat. Banco descartável: para recomeçar limpo,
`npm run db:down && docker volume rm preco-que-d-main_postgres-data && npm run db:up`.

## Limites

- Sem credenciais Neon, este banco não prova branch Neon, URLs pooled/direct,
  backup/restore ou cutover — esses itens seguem `blocked` no Plano Mestre §42.
- E2E (`npm run test:e2e`) exige além do banco: build, `npm run preview` na
  porta 4173, seed (`npm run e2e:prepare`) e browsers do Playwright instalados.
