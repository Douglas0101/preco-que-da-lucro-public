# Auditoria ambiental — correção `csf_58b444f152e35ba899b5381e`

**Tarefa:** F1-2 / C-11
**Data da auditoria:** 2026-08-26/27
**Branch:** `fix/ai-budget-reservation-csf58b4`
**Base:** `origin/develop` em `339efb0d02db1c2b868c41d87821357d61f4b021`
**Escopo:** somente ambiente de execução e teste local; nenhum endpoint Neon real,
Cloudflare, D1, produção ou segredo foi consultado.

## Conclusão executiva

O ambiente ratificado pelo repositório para esta missão é **Nitro `node-server` +
PostgreSQL 17**, com `node-postgres` para integração local/CI e
`neon-serverless` como driver de runtime configurável. O harness local existente é
`docker-compose.yml`, com PostgreSQL 17 Alpine; sua disponibilidade foi confirmada
na sessão de 2026-08-27 por `docker compose ps`, retornando o serviço saudável
`preco-que-da-lucro-postgres`.

Não há, no estado de partida, tabela `ai_usage`, colunas `tokens_reserved` ou
`in_flight`, módulo `budget-ledger`, testes de contrato do ledger ou as novas
variáveis de limite. A implementação deve introduzir esses elementos dentro do
escopo da SPEC-AMEND-001, preservando o runtime PostgreSQL atual e mantendo D1/Workers
adiado por REQ-012.

## 1. Runtime e seleção de driver

| Área                 | Evidência                        | Resultado                                                                                                        |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Servidor web         | `vite.config.ts:4-16`            | `nitro.preset` é `node-server`; o comentário explica que o default Cloudflare/Wrangler causa timeout no preview  |
| Drivers disponíveis  | `src/db/client.server.ts:1-5`    | `@neondatabase/serverless`, `drizzle-orm/neon-serverless`, `drizzle-orm/node-postgres` e `pg`                    |
| Seleção por ambiente | `src/db/client.server.ts:33-50`  | `DATABASE_DRIVER=node-postgres` usa `pg`; o default é `neon-serverless`; outros valores são rejeitados           |
| Transação de tenant  | `src/db/client.server.ts:65-100` | `withTenantTransaction` abre uma transação Drizzle e configura GUCs PostgreSQL para identidade/RLS               |
| Schema               | `src/db/schema.ts:39-737`        | Todas as tabelas são `pgTable`; não há variante `sqliteTable`/D1                                                 |
| Entrada server-side  | `src/server.ts:47-60`            | expõe `fetch(request, env, ctx)` genérico, mas o build atual é Node; não existe caminho `waitUntil` nesta missão |

**Decisão ambiental:** implementar e verificar a missão contra PostgreSQL local via
`node-postgres`; manter a interface do ledger driver-agnóstica para o contract test
do driver `neon-serverless`, sem conectar ao endpoint Neon. Isso é a aplicação de
H-003, REQ-008 rev2 e REQ-012.

## 2. Scripts npm e comandos operacionais

Fonte: `package.json:10-40`.

| Comando               | Função observada                                        | Uso nesta missão                                    |
| --------------------- | ------------------------------------------------------- | --------------------------------------------------- |
| `npm run db:up`       | `docker compose up -d --wait`                           | subir o PostgreSQL local existente                  |
| `npm run db:down`     | `docker compose down`                                   | não executado nesta auditoria                       |
| `npm run db:generate` | `drizzle-kit generate`                                  | gerar a migração versionada após atualizar o schema |
| `npm run db:check`    | `drizzle-kit check`                                     | validar drift/snapshot sem conexão com banco        |
| `npm run db:migrate`  | `tsx scripts/db/migrate.ts`                             | aplicar migrações usando `DATABASE_ADMIN_URL`       |
| `npm run db:test`     | quatro runners em sequência                             | validar migrações, auth, tools e semântica de chat  |
| `npm run test`        | `vitest run`                                            | testes unitários/componentes                        |
| `npm run check`       | checks, format, lint, typecheck, testes, build e bundle | gate completo posterior                             |
| `npm run test:e2e`    | Playwright                                              | gate E2E posterior, não F1-2                        |

`drizzle.config.ts:1-15` exige `DATABASE_ADMIN_URL` para carregar a configuração,
mas `db:check` somente verifica artefatos de migração. `scripts/db/migrate.ts:1-16`
usa `drizzle-orm/node-postgres`, `pg` e a conexão administrativa exclusivamente
para aplicar migrações.

## 3. Workflows CI e limites de segurança

### UI stack

`.github/workflows/ui-stack.yml:1-34` define o job principal em Ubuntu com serviço
`postgres:17-alpine`, banco local de teste, `DATABASE_DRIVER=node-postgres` e
`EXPECTED_POSTGRES_MAJOR=17`. As etapas de verificação relevantes estão em
`.github/workflows/ui-stack.yml:39-53` e executam checks, format, typecheck, lint,
Vitest, `db:test` e `db:check`. Build, bundle, auditoria de dependências e E2E
seguem em `.github/workflows/ui-stack.yml:69-88`.

### Neon preview boundary

`.github/workflows/neon-preview.yml:1-48` é secretless em pull requests. O job usa
um valor dummy apenas para satisfazer o guard de carregamento do Drizzle e executa
`db:check`; não cria branch, não migra e não conecta em banco remoto.

### Neon readiness

`.github/workflows/neon-readiness.yml:3-40` é manual/protegido e
`.github/workflows/neon-readiness.yml:54-140` exige credenciais e confirmações.
As etapas posteriores criam branch Neon e conectam URLs direct/pooled
(`.github/workflows/neon-readiness.yml:154-258`). Esse workflow é evidência do
programa de readiness, não é permitido nesta missão e não será usado para F1-3 ou
testes do ledger, em conformidade com H-003 e a proibição de endpoint Neon real.

Não existe workflow D1, Wrangler, SQLite ou matriz de CI dual no repositório.

## 4. Harness PostgreSQL local escolhido

Fonte: `/home/douglas-souza/preco-que-d-main/docker-compose.yml:1-20`.

- Imagem: `postgres:17-alpine`.
- Container: `preco-que-da-lucro-postgres`.
- Banco/usuário de desenvolvimento: definidos pelo compose local; valores são
  usados somente no harness local.
- Porta: `5432:5432`.
- Healthcheck: `pg_isready` contra o banco de teste, intervalo de 5 s, timeout de
  5 s e 10 tentativas.
- Volume: `postgres-data`; a auditoria não removeu volume nem reinicializou dados.

Verificação executada:

```text
docker compose ps
```

Saída relevante:

```text
NAME                          IMAGE                SERVICE    STATUS
preco-que-da-lucro-postgres   postgres:17-alpine   postgres   Up 2 days (healthy)
```

O harness escolhido para F1-3 e F3-1 é o Compose existente com `node-postgres`.
O isolamento dos testes será por tenant/fixtures, conforme os runners atuais; não
será usado endpoint remoto. A existência de volume persistente é registrada como
característica do harness, portanto os testes de schema devem consultar objetos
presentes e as migrações devem ser idempotentes; nenhuma operação destrutiva de
volume faz parte do plano.

## 5. Schema e histórico de migrações antes de F1-3

### Contador atual

`src/db/schema.ts:715-737` define `aiDailyBudgets` como `pgTable("ai_daily_budgets")`
com chave primária `(tenant_id, usage_date)` e os campos:

- `chat_count`;
- `model_call_count`;
- `tool_call_count`;
- `input_tokens`;
- `output_tokens`;
- `estimated_cost`;
- `updated_at`.

Não existem `tokens_reserved`, `in_flight`, `usage_id` ou estado de reserva nessa
tabela.

### Migrações existentes

- `drizzle/0000_p0_postgres_foundation.sql:17-28` cria `ai_daily_budgets` sem
  contadores de reserva.
- `drizzle/0005_ai_tool_call_count.sql:1-3` adiciona somente `tool_call_count` e
  atualiza o check de não negatividade.
- `drizzle/meta/_journal.json:1-31` registra seis migrações, de `0000` a `0005`;
  a próxima migração deve ser versionada após essa sequência.
- `drizzle/0001_p0_runtime_role_and_rls.sql:42-44` concede ao `app_runtime`
  `SELECT, INSERT, UPDATE` em `ai_daily_budgets`; as políticas tenant/RLS
  relacionadas estão em `:196-211`. F1-3 deverá incluir a permissão/RLS da nova
  tabela `ai_usage` de forma consistente com o padrão existente.

Busca de símbolos antes da implementação:

```text
rg -n -i 'ai_usage|tokens_reserved|in_flight|reserveAtomic|sweepOrphans|budget-ledger' \
  src drizzle scripts package.json docs .github --glob '!docs/evidence/**'
```

Resultado: nenhuma ocorrência no código, schema, migrações, scripts ou workflows.

## 6. Variáveis `AI_*` e defaults existentes

`.env.example:32-42` e `src/lib/chat.functions.ts` mostram os nomes atualmente
usados:

| Variável                         | Fonte/default observado                                                        |
| -------------------------------- | ------------------------------------------------------------------------------ |
| `AI_GATEWAY_URL`                 | endpoint compatível; fallback no código em `src/lib/chat.functions.ts:407-409` |
| `AI_GATEWAY_API_KEY`             | chave opcional; fallback `LOVABLE_API_KEY` em `:405-406`                       |
| `AI_MODEL`                       | fallback em `:409`                                                             |
| `AI_REQUEST_TIMEOUT_MS`          | default `60000` em `:533`                                                      |
| `AI_MODEL_TIMEOUT_MS`            | default `30000` em `:410-411`                                                  |
| `AI_MODEL_MAX_ATTEMPTS`          | default `2` em `:410`                                                          |
| `AI_MAX_TOOL_ROUNDS`             | default `8` em `:556`                                                          |
| `AI_CHAT_LIMIT_PER_10_MINUTES`   | default `20` em `:165`                                                         |
| `AI_DAILY_CHAT_LIMIT_PER_TENANT` | default `200` em `:180`                                                        |

As variáveis novas de REQ-006 — `AI_DAILY_MODEL_CALL_LIMIT_PER_TENANT`,
`AI_DAILY_TOKEN_LIMIT_PER_TENANT` e `AI_IN_FLIGHT_LIMIT_PER_TENANT` — não existem
no estado de partida. Não há nome antigo equivalente para reutilizar. Por causa da
proibição v3 de commitar qualquer `.env*`, F2-3 registra os nomes/defaults no módulo
server-only, na evidência de Q-005 e no `EXECUTION-STATE.md`, sem alterar o
`.env.example`. Q-005 permanece pendente até essa decisão técnica documentada.

Os runbooks listam os nomes de gateway/timeout/chat em
`docs/runbooks/hostinger-cloud-node.md:128-136`, mas não autorizam nem serão usados
para configurar infraestrutura externa nesta missão.

## 7. Runner de testes e pontos de integração

### Vitest

`vitest.config.ts:4-15` usa ambiente `jsdom`, inclui `src/**/*.test.{ts,tsx}`,
carrega `src/test/setup.ts` e restaura mocks. O runner unitário não provisiona banco
nem injeta um driver.

### Runners PostgreSQL existentes

`package.json:29` executa, em ordem:

1. `scripts/db/test-migrations.ts` — migrações, contratos de banco, RLS e
   concorrência de outros domínios;
2. `scripts/db/test-auth-integration.ts` — integração Better Auth via `pg`;
3. `scripts/db/test-tool-security.ts` — isolamento e idempotência de tools;
4. `scripts/db/test-chat-semantics.ts` — semântica de histórico de chat.

Todos importam `drizzle-orm/node-postgres`, `pg` e `src/db/schema.ts`; os pontos de
entrada são visíveis, respectivamente, em `scripts/db/test-migrations.ts:1-7`,
`scripts/db/test-auth-integration.ts:1-8`, `scripts/db/test-tool-security.ts:1-6`
e `scripts/db/test-chat-semantics.ts:1-6`.

Não existe ainda teste de concorrência do orçamento, teste de TTL/sweep ou contract
test de uma interface de ledger. F3-1 deverá adicionar os testes específicos sem
alterar `src/routes/auth.tsx`.

### Source-to-sink ratificado

O caminho atual em `src/lib/chat.functions.ts` é:

1. `reserveChatAndLoadHistory` em `:149-206` incrementa `chat_count` e verifica
   somente `AI_DAILY_CHAT_LIMIT_PER_TENANT` (`:168-181`);
2. `sendChatMessage` em `:528-541` executa esse passo antes do loop de modelo;
3. `callModel` chega ao `fetch` externo em `:400-428`, com o `fetch` efetivo em
   `:320-345`;
4. `recordModelUsage` em `:209-234` grava os tokens/model calls depois do retorno;
5. `recordToolUsage` em `:236-250` grava tool calls separadamente;
6. o loop por rounds está em `:556-598`, sem reserva/liquidação por round.

F2-2 deverá substituir somente o acesso de orçamento por chamadas ao módulo
`budget-ledger`, mantendo no próprio fluxo a preparação de histórico, ferramentas,
sanitização, autenticação e contratos existentes. O ledger deve concentrar a
transação de reserva/liquidação/expiração; `chat.functions.ts` não deve emitir SQL
de orçamento diretamente.

## 8. Superfície mínima prevista para as próximas tarefas

Esta seção é inventário e não altera o Plano silenciosamente.

| Tarefa    | Superfície provável                                                                                                                | Condição                                                       |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| F1-3      | `src/db/schema.ts`, próxima migração `drizzle/0006_*.sql`, snapshots/journal Drizzle e grants/RLS necessários                      | somente após confirmar nomes/tipos no schema atual             |
| F2-1      | novo módulo `src/lib/ai/budget-ledger.server.ts` ou caminho equivalente sob `src/lib/ai/`, interface de transação e contract tests | módulo único; clock injetável; sem SQL espalhado               |
| F2-2      | `src/lib/chat.functions.ts` e testes de integração                                                                                 | reserva antes de cada `fetch`; settle em `finally`; sweep lazy |
| F2-3      | configuração do ledger, logging estruturado e documentação dos nomes/defaults                                                      | sem alteração de `.env*`; defaults fecham Q-005                |
| F3-1/F3-2 | novos testes PostgreSQL/ledger e runner local                                                                                      | tenants isolados; gateway mockado; CN local                    |
| F4        | somente artefatos/evidências autorizados, sem `auth.tsx`                                                                           | gates posteriores                                              |

Qualquer incompatibilidade descoberta ao editar o schema ou integrar o ledger vira
nova Q antes de ampliar essa superfície, conforme C-06/C-11.

## 9. Subagents e evidência

Newton (CI/harness) e Sartre (schema/env) foram acionados como sidecars somente
leitura. Ambos entregaram handoff mínimo após a janela bounded:

- Newton confirmou estaticamente os três workflows, o Compose PostgreSQL 17, os
  scripts `db:*`, a separação local/CI e os limites do workflow Neon, com evidências
  em `.github/workflows/ui-stack.yml:11-88`, `docker-compose.yml:1-20`,
  `package.json:10-40` e `docs/runbooks/postgres-local-docker.md:9-20`.
- Sartre confirmou estaticamente a ausência pré-F1-3 de `tokens_reserved`,
  `in_flight`, `ai_usage`, limites de model calls e contract tests, além dos call
  sites em `src/lib/chat.functions.ts:149-641` e do runner Vitest em
  `vitest.config.ts:4-15`.

Nenhum dos dois editou arquivos, executou migrations, acessou Neon ou produziu
alteração de Git. Os handoffs corroboram o inventário; as verificações do banco e
da migration F1-3 foram executadas independentemente pela linha principal, em
conformidade com C-12/D-13.

## 10. Gate G-AMBIENTE

**Estado:** PASS.

Critérios verificados:

- scripts npm e runner de banco inventariados;
- workflows CI e boundary Neon documentados sem uso remoto;
- harness PostgreSQL 17 local confirmado saudável;
- schema/counters/usage atuais inventariados;
- variáveis `AI_*` e defaults existentes identificados;
- seleção de driver por ambiente confirmada;
- runner Vitest e runners PostgreSQL documentados;
- mecanismo escolhido: Compose PostgreSQL local + `node-postgres`;
- superfície de implementação limitada e sem `src/routes/auth.tsx`.

F1-2 não aplicou migração, não alterou banco, não chamou Neon e não alterou código
de produção. O próximo gate é F1-3/G-SCHEMA.
