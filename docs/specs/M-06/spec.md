# M-06 — Baseline controlado, performance e observabilidade

**Status:** DRAFT
**Trilha:** B-2
**Origem:** RAT SA-03/Hypatia e reconciliação do checkout de 2026-08-27
**Congelamento:** reservado para Q-020; este documento não cria gate nem congela M-06

## 1. Objetivo e fronteira de evidência

M-06 define o workload, o protocolo de medição e os artefatos necessários para
obter um baseline reproduzível de backend, banco, pool, frontend e caminho de
IA. A regra é **workload primeiro, código depois**: nenhuma implementação de
runner, instrumentação ou otimização pode alterar o workload congelado sem uma
revisão explícita.

Os rótulos usados nesta spec são normativos:

- **CODE-PROVED:** comportamento presente e verificável no checkout atual;
- **OBSERVED:** comportamento observado em código ou artefato, sem significar
  que uma métrica já foi medida;
- **PLANNED:** desenho aprovado para a implementação posterior de M-06, ainda
  sem execução;
- **NOT-EXECUTED:** cenário ou métrica ainda não executado;
- **UNKNOWN:** dimensão que não pode ser confirmada com a evidência disponível.

O baseline local não será apresentado como prova de Neon, CI, Hostinger,
produção, cold activation Neon ou cumprimento de SLO. Cada resultado deverá
carregar SHA, estado do worktree, ambiente, driver, perfil de seed, parâmetros
do runner e timestamp.

## 2. Estado atual observado

O checkout atual fornece estes pontos de partida:

| Área                    | Estado factual                                                                                                | Evidência                                                                               | Classificação            |
| ----------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------ |
| Read model do dashboard | seis consultas no caminho atual; a independência em relação à cardinalidade é coberta pelos testes existentes | `src/server/repositories/dashboard.repository.ts`, `src/test/query-performance.test.ts` | CODE-PROVED/OBSERVED     |
| Read model de produtos  | cinco consultas e caps de leitura; `products` tem limite 500 e filhos têm limite global 2.000                 | `src/server/repositories/product-catalog.repository.ts`, `src/lib/list-limits.ts`       | CODE-PROVED/OBSERVED     |
| Diagnóstico             | caminho de `getDiagnostic` existente; filhos do detalhe não formam ainda um benchmark de percentis            | `src/lib/diagnostic.functions.ts`, repositories alcançados pelo serviço                 | CODE-PROVED/NOT-EXECUTED |
| Formação de preço       | `calculatePriceFormationServer` recebe payload validado; o benchmark deverá usar entrada determinística       | `src/lib/price-formation.functions.ts`                                                  | CODE-PROVED/NOT-EXECUTED |
| Chat                    | `sendChatMessage` pode abrir até oito rounds e deve ser executado com provider mockado no benchmark           | `src/lib/chat.functions.ts`, `src/lib/chat-execution.server.ts`                         | CODE-PROVED/PLANNED      |
| Vitals                  | o cliente coleta CLS/FCP/INP/LCP/TTFB; `/api/vitals` valida, registra log e retorna 204 sem persistência      | `src/lib/web-vitals.client.ts`, `src/routes/api/vitals.ts`                              | CODE-PROVED              |
| Runner de carga         | não há `autocannon`, `k6`, `wrk`, `oha` ou `bombardier` instalado/configurado                                 | inventário do checkout e `package.json`                                                 | CODE-PROVED/NOT-EXECUTED |
| Query stats             | não há configuração atual de `pg_stat_statements`                                                             | `docker-compose.yml` e inventário de scripts                                            | CODE-PROVED/NOT-EXECUTED |
| Pool saturation         | não há série de saturação pronta                                                                              | inventário de instrumentação                                                            | NOT-EXECUTED/UNKNOWN     |
| Cold activation         | não medido; um restart local será apenas proxy                                                                | baseline M-02 e ausência de harness                                                     | NOT-EXECUTED             |

O run remoto `33080843742` não é benchmark de p95/p99. Ele executou
`Neon readiness` em `refs/heads/develop`, SHA
`12c90a17f81edd5a126c2e32c3f703c8b7841f87`, e falhou em T6/E6 no cenário de
barreira in-flight. A asserção foi `gatewayCalls <= 2`, em
`scripts/db/test-ai-budget.ts:427`; portanto, E6 é um cenário de admissão
concorrente separado da medição de latência deste módulo.

## 3. Caminhos sob medição

O catálogo lógico de cenários será fixo antes da implementação:

| ID                      | Caminho                                                          | Perfil/variante                    | Instrumento                                               |
| ----------------------- | ---------------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| `dashboard-summary`     | `getDashboardSummary` / dashboard de `/inicio`                   | S, M, L                            | `autocannon` no harness local e navegação Playwright      |
| `products-with-metrics` | `listProductsWithMetrics`                                        | S, M, L; observar caps             | `autocannon` no harness local                             |
| `diagnostic`            | `getDiagnostic` para um produto selecionado                      | S, M, L                            | `autocannon` no harness local                             |
| `price-formation`       | `calculatePriceFormationServer`                                  | payload válido fixo                | `autocannon` no harness local                             |
| `chat-no-tool`          | `sendChatMessage` com provider mockado e resposta final          | histórico controlado; 1/4/8 rounds | harness de serviço, sem gateway externo                   |
| `chat-one-tool`         | `sendChatMessage` com provider mockado e uma tool determinística | histórico controlado; 1/4/8 rounds | harness de serviço, sem gateway externo                   |
| `ui-vitals`             | carregamento controlado de `/inicio` e fluxo de diagnóstico      | S, M, L quando aplicável           | Playwright                                                |
| `e6-inflight`           | oito requests concorrentes contra a barreira de dois slots       | fixture isolada                    | `db:test`/harness de concorrência, separado dos percentis |

Os nomes dos caminhos representam operações da aplicação. Não será criada uma
rota pública de produção apenas para o benchmark. O harness de API será um
processo auxiliar, exclusivo de loopback, que invoca o mesmo caminho de
service/repository e recebe fixture de identidade/tenant controlada. A
navegação Playwright contra o preview cobrirá o comportamento de UI e request
real sem transformar o harness em superfície pública.

## 4. Decisões DRAFT de M-06

### M06-D-001 — workload determinístico

Usar os perfis S/M/L definidos em `workload.md`. Cada execução deve declarar o
perfil, a cardinalidade real produzida pelo seed e qualquer truncamento pelos
limites de leitura. Além da cardinalidade do seed, cada bucket de latência deve
declarar `N`, o número de observações válidas que realmente o compõem. O p99 é
`N/A` quando `N < 100`; não se deve fabricar precisão agregando perfis ou
repetições incompatíveis. Não extrapolar uma métrica de S para M ou L.

### M06-D-002 — runner

Usar `autocannon` como dependência de desenvolvimento, fixada no lockfile. O
runner deverá bindar somente em `127.0.0.1`, recusar `NODE_ENV=production` e
ser excluído do bundle de produção. Para qualquer cenário de chat/IA, o
provider-fixture local é obrigatório e deve falhar fechado se houver tentativa
de gateway externo; `k6`, `wrk` e outros binários externos não são dependências
desta primeira implementação.

### M06-D-003 — protocolo estatístico

Para cada cenário e perfil, executar warm-up de 10 s, medição de 30 s, três
repetições e concorrência 1, 2, 4 e 8. Registrar p50, p95 e p99, throughput,
taxa de erro e número de respostas. A distribuição bruta, e não somente os
percentis, deve ser preservada no JSON de evidência. Calcular o p50 de cada
repetição e o coeficiente de variação entre repetições; CV acima de 10% no p50
exige reexecução registrada, não descarte silencioso da repetição.

### M06-D-004 — banco e conexão

O baseline local usará PostgreSQL 17 Docker e `DATABASE_DRIVER=node-postgres`.
`DATABASE_URL` permanece a conexão de runtime; `DATABASE_ADMIN_URL` fica
restrita ao setup, migration e coleta administrativa do harness. Nenhuma
credencial poderá aparecer no JSON, logs ou Markdown.

### M06-D-005 — instrumentação de query

No ambiente local do harness, iniciar o Postgres com
`shared_preload_libraries=pg_stat_statements` e criar a extensão no setup com a
conexão administrativa. Chamar `pg_stat_statements_reset()` entre repetições,
com a mesma conexão administrativa e registrar o instante da limpeza. Capturar
`calls`, `total_exec_time`, `mean_exec_time`, `rows` e padrões de query
antes/depois de cada cenário. Se a extensão ou a operação administrativa não
estiver disponível, o resultado será `UNKNOWN`; não será substituído por
estimativa.

### M06-D-006 — pool e atividade

Coletar `pg_stat_activity` durante as janelas medidas e, quando o driver
permitir, estatísticas do pool: conexões ativas, idle, waiting/queue e máximo.
As amostras terão timestamp e serão correlacionadas ao cenário. O harness
deverá informar explicitamente quais dimensões não foram expostas pelo driver e
rotular cada linha com o ambiente (`local-postgres-17`, proxy local de cold
start ou outro ambiente autorizado), sem misturar séries.

### M06-D-007 — vitals e cold activation

Playwright medirá TTFB, LCP e CLS em navegação controlada; FCP será capturado
quando disponível. INP permanece `RUM-ONLY`, pois o endpoint atual não persiste
uma série controlada. Restart do app ou do container local pode ser usado como
proxy de cold start, mas não será chamado de cold activation Neon. O cold local
deverá separar, quando mensurável, `compute-wake` de `first-query`; a soma não
será apresentada como latência Neon.

### M06-D-008 — E6

E6 permanece cenário de barreira de concorrência, não um teste de p95. O
resultado deve imprimir `gatewayCalls`, `peakActiveCalls`, sucessos e
rejeições, preservando as asserções `gatewayCalls <= 2` e
`peakActiveCalls <= 2`. Relaxar a asserção para obter readiness verde é
proibido. Se a implementação de M-06 alterar o harness ou a admissão, um
readiness futuro deverá usar o SHA exato publicado da alteração. A matriz de
estabilidade do harness usa `E6_HOLD_MS` em `300/600/1200` ms e `E6_QUEUE_MS`
em `0/50/200/500` ms, totalizando 12 combinações; cada linha preserva 8
tentativas, 2 admitidos, 2 sucessos, 6 rejeições `AI_QUOTA` e counters zerados.

### M06-D-009 — interpretação de SLO

Targets de SLO e error budget serão derivados do baseline e rotulados
`CONTROLLED`. O baseline define targets de trabalho; não prova que os targets
foram cumpridos e não autoriza cutover ou produção.

## 5. Segurança e fronteiras operacionais

O harness deverá:

- usar tenant e usuário de fixture determinísticos;
- passar pela mesma validação de contexto tenant-scoped do caminho testado;
- não aceitar host remoto ou ambiente de produção;
- não usar `DATABASE_ADMIN_URL` como conexão de aplicação;
- não escrever em Neon persistente nem em produção;
- não incluir segredos, cookies reais ou tokens em evidência;
- limpar somente IDs pertencentes à própria fixture;
- falhar fechado quando o ambiente não puder ser identificado como local;
- manter `/api/vitals` como endpoint de ingestão RUM, não como instrumento de
  benchmark.

Qualquer código executável novo do runner, seed ou adapter será revisado pelo
scan de segurança do diff correspondente. O scan parcial do M-01 não será
promovido a cobertura do código novo de M-06.

## 6. Estado de congelamento

Esta é uma spec DRAFT. M06-D-001..D-009 são decisões propostas para revisão
humana em Q-020. M-06 permanece sem implementação, sem métricas medidas, sem
readiness verde e sem gate consumido até que o DoD seja satisfeito.
