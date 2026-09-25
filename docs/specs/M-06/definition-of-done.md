# M-06 — Definition of Done

**Status:** DRAFT
**Congelamento:** Q-020
**Dependência:** workload definido em `workload.md` antes de qualquer runner

M-06 só poderá ser marcado como concluído quando todos os itens abaixo tiverem
evidência correspondente. A existência desta lista não significa que qualquer
item já foi executado.

## 1. Especificação e rastreabilidade

- [ ] `spec.md`, `workload.md` e este documento permanecem marcados como DRAFT
      até Q-020.
- [ ] Cada cenário está associado a uma operação real:
      `getDashboardSummary`, `listProductsWithMetrics`, `getDiagnostic`,
      `calculatePriceFormationServer` e `sendChatMessage`.
- [ ] Os perfis S/M/L estão fixados em 1/100/500 produtos, quatro filhos por
      produto e 30/500/1.000 despesas.
- [ ] Warm-up, janela de medição, repetições, concorrência e percentis estão
      registrados no manifesto de cada run.
- [ ] Cada bucket declara `N`; p99 é `N/A` quando `N < 100`, sem combinar
      perfis para atingir o limiar.
- [ ] CV acima de 10% no p50 dispara reexecução identificada e preserva os
      runs originais.
- [ ] O relatório separa `CODE-PROVED`, `OBSERVED`, `PLANNED`,
      `NOT-EXECUTED`, `UNKNOWN` e `CONTROLLED`.

## 2. Seed e isolamento

- [ ] Existe seed M-06 dedicado, determinístico, reexecutável e separado de
      `scripts/db/explain-evidence.ts`.
- [ ] O seed usa uma fixture identificável e limpa somente seus próprios IDs.
- [ ] Execução fora de ambiente local falha fechado, salvo fluxo externo
      explicitamente autorizado.
- [ ] O manifesto confirma cardinalidades produzidas, não apenas as
      cardinalidades solicitadas.
- [ ] Caps de produtos, filhos, despesas e simulações aparecem no resultado
      quando aplicáveis.

## 3. Runner e caminhos de aplicação

- [ ] `autocannon` está instalado somente como dependência de desenvolvimento,
      com versão fixada no lockfile.
- [ ] O harness bindará somente em `127.0.0.1`.
- [ ] O harness recusa `NODE_ENV=production` e não entra no bundle de produção.
- [ ] O harness exercita o mesmo service/repository path do cenário e não
      adiciona uma rota pública permanente.
- [ ] `sendChatMessage` usa provider mockado, sem chamada externa, com variantes
      sem tool e com uma tool determinística.
- [ ] Qualquer tentativa de gateway externo invalida o cenário de chat e é
      registrada como `INVALID-RUN`.
- [ ] Falhas de infraestrutura são marcadas como `INVALID-RUN`,
      `NOT-EXECUTED` ou `UNKNOWN`, nunca como latência zero.

## 4. Banco, queries e pool

- [ ] O baseline local roda em PostgreSQL 17 com
      `DATABASE_DRIVER=node-postgres`.
- [ ] `DATABASE_URL` é usado pelo runtime e `DATABASE_ADMIN_URL` somente para
      setup/coleta administrativa.
- [ ] O Postgres local é iniciado com `pg_stat_statements` habilitado e a
      extensão é criada no setup do harness.
- [ ] Cada cenário preserva `calls`, `total_exec_time`, `mean_exec_time`,
      `rows` e padrões de query quando a extensão estiver disponível.
- [ ] `pg_stat_statements_reset()` é executado entre repetições pela conexão
      administrativa, com timestamp e resultado preservados.
- [ ] `pg_stat_activity` é amostrado durante a carga.
- [ ] Estatísticas do pool são coletadas quando expostas pelo driver; dimensões
      ausentes são `UNKNOWN`, com label de ambiente em cada série.

## 5. Métricas e vitals

- [ ] Cada combinação cenário × perfil aplicável tem três repetições e
      concorrências 1, 2, 4 e 8, salvo justificativa registrada.
- [ ] Cada run fornece p50, p95 e p99, throughput, taxa de erro e contagem de
      respostas a partir dos dados brutos.
- [ ] Playwright mede TTFB, LCP e CLS em navegação controlada, com FCP quando
      disponível.
- [ ] INP está explicitamente rotulado `RUM-ONLY`.
- [ ] `/api/vitals` é validado somente como ingestão/contrato 204, não como
      fonte de percentis do benchmark.
- [ ] Restart local, se executado, é rotulado proxy de cold start e não cold
      activation Neon, com separação `compute-wake`/`first-query` quando
      observável.

## 6. E6 e readiness

- [ ] E6 é executado como cenário separado de concorrência in-flight.
- [ ] A saída imprime `gatewayCalls`, `peakActiveCalls`, sucessos e rejeições.
- [ ] Permanecem as invariantes `gatewayCalls <= 2` e
      `peakActiveCalls <= 2`.
- [ ] A matriz de estabilidade 3 × 4 (`E6_HOLD_MS` × `E6_QUEUE_MS`) é
      executada sem alterar o runtime e preserva 2/2/6 e counters zerados.
- [ ] Nenhuma asserção é relaxada para fazer readiness passar.
- [ ] Se M-06 alterar o harness ou a implementação de admissão, o readiness
      externo só é considerado depois de execução no SHA exato publicado.
- [ ] O run `33080843742` continua registrado como falha em E6 no
      `develop@12c90a17`; ele não é usado como prova de benchmark do worktree
      atual.

## 7. Evidência, SLO e segurança

- [ ] JSON bruto, manifesto, resumo, query stats, pool stats, vitals e logs de
      erro são preservados juntos por execução.
- [ ] O resumo inclui SHA completo, estado dirty/clean, versões e parâmetros.
- [ ] SLO/error budget é derivado do baseline e rotulado `CONTROLLED`; nenhum
      target é declarado cumprido sem critério explícito.
- [ ] Nenhum segredo, cookie real, token ou `DATABASE_ADMIN_URL` aparece nos
      artefatos.
- [ ] Código executável novo do runner/seed/adapter passa por revisão de
      segurança do diff correspondente.
- [ ] O scan parcial do M-01 não é usado como cobertura do novo código de
      M-06.

## 8. Evidência negativa obrigatória

Se qualquer item não puder ser executado, o pacote final deverá dizer por quê e
usar o rótulo correto:

- `NOT-EXECUTED` para cenário ainda não rodado;
- `BLOCKED` para dependência externa/credencial ausente;
- `UNKNOWN` para dimensão não observável no ambiente;
- `HYPOTHESIS` para explicação ainda não demonstrada.

M-06 não fecha por completar o runner ou por produzir números. Fecha quando os
números são reproduzíveis, o workload é rastreável, as falhas são visíveis, as
fronteiras de ambiente são respeitadas e todos os limites de evidência estão
registrados.
