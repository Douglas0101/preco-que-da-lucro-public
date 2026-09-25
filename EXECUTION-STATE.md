# EXECUTION-STATE — csf_58b444f152e35ba899b5381e

Estado persistente da execução do fix `resource-exhaustion.ai-budget-race`.
Este arquivo não contém credenciais, tokens, URLs Neon reais ou conteúdo de mensagens.

## Identidade da execução

- Mandato vigente: v3, desbloqueado por H-001..H-003 em 2026-08-26.
- Finding: `csf_58b444f152e35ba899b5381e` (CWE-770).
- Branch do fix: `fix/ai-budget-reservation-csf58b4`.
- Base ratificada: `origin/develop` em `339efb0d02db1c2b868c41d87821357d61f4b021`.
- Tip publicado anterior do fix: `c2ff86fdd9ab025d31199816aeb6682268e9f01f`.
- Tip de código verificado/publicado atual do fix: `e61c8c80ed7477828e0f44fd6a0c4f799ae9aa48`.
- PR draft: `#21` — https://github.com/Douglas0101/preco-que-da-lucro/pull/21.
- Preservação local: `wip/preservacao-c371032-20260826`, não publicada.
- Início desta execução v3: `2026-08-26T21:43:51-03:00`.
- Última atualização: `2026-08-27T03:10:00Z`.

## Decisões humanas — transcrição verbatim

> **H-001** — "Aprovo a Opção C e a SPEC-AMEND-001."

> **H-002** — "Autorizo a execução das Fases 1–4 sob os poderes v2 e os deltas propostos."

> **H-003** — "Q-008 permanece NÃO: usar contract tests para os drivers; não usar endpoint Neon."

### Efeitos registrados

- Q-007 resolvida: Opção C, com REQ-008 rev2, REQ-010, REQ-011 e REQ-012.
- SPEC-AMEND-001 ratificada e vigente para esta execução.
- Q-008 resolvida como NÃO: node-postgres contra PostgreSQL local/efêmero; contract
  tests para `neon-serverless`; nenhum endpoint Neon real.
- Fases 1–4 autorizadas somente dentro dos poderes e proibições do mandato v3.

### Não-efeitos preservados

- Sem merge, sem push da `wip/`, sem push direto em `main`/`develop` e sem force-push.
- Sem migração, escrita, restore, backup, cutover ou teste em Neon real.
- Sem alteração de ADR-021, `src/routes/auth.tsx`, secrets de produção ou billing do provedor.
- Sem implementação de D1/Workers; portabilidade permanece adiada por REQ-012.

## Perguntas e decisões

| ID                        | Owner   | Status nesta execução                                |
| ------------------------- | ------- | ---------------------------------------------------- |
| Q-001 (A1)                | HUMANO  | Aberta e intocada                                    |
| Q-002 (TAC)               | EXTERNO | Aberta e intocada                                    |
| Q-003 (merge)             | HUMANO  | Aberta e intocada                                    |
| Q-004 (destino da `wip/`) | HUMANO  | Aberta e intocada                                    |
| Q-005 (defaults)          | AGENTE  | Resolvida em F2-3: defaults registrados abaixo       |
| Q-006 (validade no tip)   | AGENTE  | Resolvida por T-03, saída (a)                        |
| Q-007 (D1)                | HUMANO  | Resolvida por H-001; portabilidade adiada em REQ-012 |
| Q-008 (endpoint Neon)     | HUMANO  | Resolvida por H-003: NÃO                             |

## Ledger de tarefas

Status permitidos: `PENDING`, `IN_PROGRESS`, `DONE`, `BLOCKED`, `NOT_RUN`.

| Tarefa                                | Status | Evidência / predicado de retomada                                                                                                                                               |
| ------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T-00 / partida histórica              | DONE   | Log de execução preservado; worktree inicial catalogado                                                                                                                         |
| T-01 / preservação histórica          | DONE   | `a14fdb9` na `wip/`, não publicada                                                                                                                                              |
| T-02 / SHA histórico                  | DONE   | `origin/develop=339efb0d02db1c2b868c41d87821357d61f4b021`                                                                                                                       |
| T-03 / SPEC-RATIFICADA histórica      | DONE   | Diff vazio de `src/lib/chat.functions.ts`; saída (a)                                                                                                                            |
| F1-1 / branch, evidências e estado    | DONE   | `10d257d9fa0a9697616cf08ba423db30c183dead`; G-AMBIENTE-0 passou                                                                                                                 |
| F1-2 / auditoria ambiental C-11       | DONE   | `docs/auditoria-ambiental-2026-08-26.md`; G-AMBIENTE passou                                                                                                                     |
| F1-3 / schema local                   | DONE   | `drizzle/0006_loud_lockjaw.sql`; `db:check` passou; migration aplicada duas vezes; objetos verificados                                                                          |
| F2-1 / módulo budget-ledger           | DONE   | `src/lib/ai/budget-ledger.server.ts`; reserve/settle/sweep; typecheck + T1–T10 verdes                                                                                           |
| F2-2 / integração no chat             | DONE   | Reserva antes de `modelCaller`; finally liquida cada round; nenhum SQL de orçamento em chat                                                                                     |
| F2-3 / configuração e observabilidade | DONE   | Defaults e eventos estruturados registrados abaixo; Q-005 resolvida                                                                                                             |
| F3-1 / T1–T10                         | DONE   | `npm run db:test` e runner focado verdes no PostgreSQL 17 local                                                                                                                 |
| F3-2 / T-CN                           | DONE   | Baseline sem fix: gateway=20; fix: E1 gateway=1                                                                                                                                 |
| F4-1 / qualidade                      | DONE   | CI do tip `e61c8c8` verde em UI/E2E, build, lint, typecheck e suíte; `npm run check` local reproduziu somente falha preexistente do property test financeiro, fora do write-set |
| F4-2 / secrets                        | DONE   | Diff do tip sem `.env*`, chaves, credentials ou secrets; canário auth vazio                                                                                                     |
| F4-3 / push e PR draft                | DONE   | Push normal de `e61c8c8`; PR draft #21 aberto; nunca merge                                                                                                                      |
| F4-4 / CI                             | DONE   | UI `33034852220`/job `98395236325`, Neon boundary `33034852213`/job `98395236526` e Sonar `98395300602`: SUCCESS no SHA exato e61                                               |
| F4-5 / re-scan                        | DONE   | Standard local `2ca2b19a-3ab2-49a1-a436-0a9ab46b3fcd`; zero findings reportáveis nas superfícies revisadas; cobertura parcial 6/240                                             |
| F4-6 / canário auth                   | DONE   | `git diff origin/develop..HEAD -- src/routes/auth.tsx`: saída vazia; confirmado no tip `e61c8c8`                                                                                |
| F4-7 / relatório final                | DONE   | Relatório obrigatório e `EXECUTION-STATE.md` atualizados; artefatos canônicos do scan copiados e hash verificado                                                                |

## Registro de gates

| Gate             | Estado | Evidência                                                                                                      |
| ---------------- | ------ | -------------------------------------------------------------------------------------------------------------- |
| G-AMBIENTE-0     | DONE   | HEAD `10d257d9fa0a9697616cf08ba423db30c183dead`; ancestry em `339efb0`; status limpo; wip sem ref remota       |
| G-AMBIENTE       | DONE   | `docs/auditoria-ambiental-2026-08-26.md`; harness PostgreSQL 17 confirmado                                     |
| G-SCHEMA         | DONE   | `ai_usage`, counters, índice, checks, RLS e grants verificados no PostgreSQL local                             |
| G-IMPL           | DONE   | typecheck + inspeção de ordem/isolamento; reserva antes do gateway e settle em `finally`                       |
| G-TEST           | DONE   | `npm run db:test`: migrações/auth/tools/chat + T1–T10; T-CN reproduziu o race no baseline                      |
| G-QUALITY        | DONE   | CI do SHA `e61c8c8` verde em todos os checks; ressalva local não relacionada registrada em F4-1 e no relatório |
| G-SCAN           | DONE   | Scan Standard `2ca2b19a-3ab2-49a1-a436-0a9ab46b3fcd` selado; `findings.json` vazio, cobertura parcial 6/240    |
| MISSÃO-CONCLUÍDA | DONE   | F4-7 concluída; PR draft aberto, sem merge; canário e wip preservados                                          |

## Regras de retomada

1. Revalidar `HEAD`, worktree, ancestry da base e integridade da `wip/` antes de cada gate.
2. Se `origin/develop` divergir, aplicar D-12: re-ratificar source-to-sink antes de
   prosseguir; alteração estrutural exige parada e nova decisão.
3. Uma tarefa só passa a `DONE` após seu método de verificação e evidência serem registrados.
4. Subagent sem handoff mínimo (claim + comando + saída ou file:line) não é evidência.
5. Q humana/externa, endpoint Neon real, secrets, `src/routes/auth.tsx`, merge ou operação
   fora dos poderes interrompem a execução.

## F1-3 — evidência do schema local

- `DATABASE_ADMIN_URL=...127.0.0.1:5432... npm run db:check`: PASS (`Everything's fine`).
- `DATABASE_ADMIN_URL=...127.0.0.1:5432... npm run db:migrate`: PASS; segunda execução
  também PASS, sem erro e sem reaplicar a migration registrada.
- Consulta administrativa corrigida: `information_schema.columns` confirmou
  `tokens_reserved`, `in_flight` e os dez campos de `ai_usage`; `pg_indexes` confirmou
  `ai_usage_tenant_status_reserved_idx`; constraints confirmaram PK/FK/checks; `pg_class`
  e `pg_policies` confirmaram RLS/policy `tenant_isolation`; `has_table_privilege`
  confirmou SELECT/INSERT/UPDATE para `app_runtime`.
- Primeira tentativa de consulta administrativa falhou somente por quoting do script
  inline (`column "public" does not exist`); nenhuma alteração ocorreu e a mesma
  verificação foi repetida com delimitador correto e passou.

## F2/F3 — ledger, integração e evidência comportamental

- `src/lib/ai/budget-ledger.server.ts` concentra `reserveAtomic`, `settle` e `sweepOrphans`,
  com clock injetável, tenant autenticado, transações PostgreSQL, guard de status
  `reserved`, retry único seguro para falha de cliente após commit e proteção mínima do
  TTL (`MIN_SAFE_RESERVATION_TTL_MS=120000`) acima do timeout de request de 60 s.
- `src/lib/chat-execution.server.ts` chama a reserva de model round antes de `modelCaller`,
  não contém SQL de orçamento fora do ledger e liquida em `finally` tanto em sucesso quanto
  em timeout, abort, erro do provedor e tool round. `src/lib/chat.functions.ts` permanece
  como adapter do server function e não contém SQL de `ai_usage`, `tokens_reserved` ou
  `in_flight`.
- Defaults fechados em Q-005: `AI_DAILY_MODEL_CALL_LIMIT_PER_TENANT=500`,
  `AI_DAILY_TOKEN_LIMIT_PER_TENANT=1500000`, `AI_DAILY_CHAT_LIMIT_PER_TENANT=200`,
  `AI_IN_FLIGHT_LIMIT_PER_TENANT=2`, `AI_CONSERVATIVE_TOKEN_BUDGET=64000` e
  `AI_BUDGET_RESERVATION_TTL_MS=120000`. A escolha conserva o limite de chat existente
  (`AI_DAILY_CHAT_LIMIT_PER_TENANT=200`) e adiciona teto diário, concorrência 2 e
  reserva de 64k com TTL de 120s; nomes e limites são validados no código.
- Os defaults novos estão documentados no módulo e neste estado. `.env.example` foi
  deixado sem alteração para cumprir a proibição v3 sobre commits `.env*`; nenhum
  segredo foi adicionado.
- `DATABASE_DRIVER=node-postgres ... npm run db:test`: migration zero, auth/tenant,
  tools, chat e T1–T10 passaram. O runner de orçamento isolado também passou após a
  correção de lint da sanitização de valores estruturados.
- T-CN em worktree/branch local descartável, sem fix: `T-CN/E1 sem fix: FAIL conforme
esperado — gateway=20, peak=16`. Com fix, T1/E1 confirmou exatamente uma invocação
  do gateway e 19 rejeições `AI_QUOTA`.
- G-QUALITY: no candidato anterior, `npm run check` passou UI stack, ausência de Supabase,
  Prettier, ESLint, TypeScript, 25 arquivos/272 testes Vitest e build Nitro; `npm run
check:bundle` passou (`index-C6f6_f0_.js`, 223681 minified, 68814 gzip, 59881 Brotli).
  Após a correção do limite de empacotamento, o build local passou sem warnings e o CI do
  SHA exato `e61c8c8` repetiu build, suíte, E2E/browser e Sonar com sucesso. Uma execução
  local posterior de `npm run check` falhou de modo reprodutível somente no teste
  preexistente `src/test/finance.properties.test.ts` (`preço formado cresce...`): o
  gerador aceita um alvo maior que se torna inválido após taxas. Nenhum arquivo financeiro
  foi alterado; não foi aplicada correção fora do escopo.

## Revisões independentes de segurança

- Schrodinger (pré-edição): handoff mínimo registrou o finding no HEAD 057 e o caminho
  antigo `callModel` antes de `recordModelUsage`, usando `git show HEAD:src/lib/chat.functions.ts`
  com linhas numeradas; sem edição, rede ou Neon.
- Hume (pós-candidato): handoff registrou reserva antes de `modelCaller`, settlement
  guardado por `usage_id/tenant_id/status='reserved'` e ausência de SQL de orçamento em
  `chat.functions.ts`; apontou a necessidade de tratar falha pós-commit, coberta pelo
  retry idempotente e pelo caso T2/E2. Sem edição, rede ou Neon.
- Noether: revisão final pós-quality gate foi encerrada após a janela bounded sem handoff
  transferível; conforme C-12, silêncio não foi tratado como aprovação, rejeição ou
  evidência. O handoff válido de Hume permanece a revisão final transferível.

## F4-2 — auditoria pré-publicação

- Commits do fix antes da correção de empacotamento: `839d99d` (implementação) e
  `d9c124e` (testes, harness e evidências); checkpoint publicado anterior
  `899ec8b`; correção publicada `c2ff86f`.
- `git diff --name-only origin/develop..HEAD` listou somente schema/migração, ledger,
  executor server-only, chat, testes, documentação e estado; não listou `.env*`,
  `*.pem`, `*.key`, `credentials*` ou `secrets*`.
- `git diff --exit-code origin/develop..HEAD -- src/routes/auth.tsx`: PASS, sem
  alteração. `git diff --check origin/develop..HEAD`: PASS.
- `git ls-remote --heads origin wip/preservacao-c371032-20260826`: saída vazia;
  nenhuma ref remota da preservação foi publicada.

## F4-3/F4-4 — publicação e CI

- `git push origin fix/ai-budget-reservation-csf58b4`: PASS para `c2ff86f`; operação
  normal, sem force-push e sem alterar `main`/`develop`.
- PR draft #21 está aberto para `develop`, com `isDraft=true`,
  `baseRefName=develop`, `headRefName=fix/ai-budget-reservation-csf58b4` e
  `headRefOid=c2ff86fdd9ab025d31199816aeb6682268e9f01f`.
- No checkpoint anterior `899ec8b`, o `Neon preview database` `33031199219`
  passou e o `SonarCloud Code Analysis` passou. O `UI stack` `33031199183` falhou
  somente no passo `npm run build`, depois de compilar, por warnings não registrados
  de módulos Node externalizados no browser (`node:crypto`, `pg`, `net`, `fs`,
  `tls` e outros). O diagnóstico local atribuiu a regressão à exportação de
  `sendChatMessageForTests` em `chat.functions.ts`, que expunha o grafo server-only
  ao bundle cliente.
- O build de `origin/develop` não emitiu warnings; após remover a exportação e
  separar `src/lib/chat-execution.server.ts`,
  `BUILD_RELEASE_CHANNEL=pre-beta-internal npm run build` passou com
  `.artifacts/build-warnings.json` em `passed=true` e `observedWarnings=[]`.
  `npm run check` completo passou no candidato corrigido.
- `c2ff86f` foi publicado em `2026-08-27`; o diagnóstico de empacotamento foi seguido por
  `58fb605` (redução de duplicação no harness), `7b2fc39` (redução de complexidade do
  executor), `c458144` (centralização dos helpers) e `e61c8c8` (correção da fronteira de
  build). O CI do SHA final `e61c8c8` foi aguardado dentro do limite bounded e passou:
  UI `33034852220`/`98395236325`, boundary secretless `33034852213`/`98395236526` e
  Sonar `98395300602`.
- O workflow de preview é observado somente como CI do PR; não houve endpoint Neon
  operado pela missão e H-003/Q-008 permanecem vigentes.

## F4-5 — re-scan Standard local no tip final

- Scan ID: `2ca2b19a-3ab2-49a1-a436-0a9ab46b3fcd`.
- SHA alvo: `e61c8c80ed7477828e0f44fd6a0c4f799ae9aa48`.
- Estado: COMPLETO/SELADO; `findings.json` sem achados reportáveis e sem severidades
  registradas nas superfícies auditadas.
- Cobertura: `partial`; seis superfícies com recibo de revisão de um inventário de 240
  arquivos. O restante foi marcado `needs_follow_up`; este resultado não afirma ausência
  de outras vulnerabilidades.
- Exclusões explícitas: Neon/produção, billing/tráfego real do provedor,
  `src/routes/auth.tsx`, TAC/chatgpt.com/cyber e portabilidade D1/Workers.
- Artefatos copiados para
  `docs/evidence/security-scan/csf-58b444f-2026-08-27/`:
  `report.md`, `findings.json`, `coverage.json`, `scan-manifest.json` e `results.sarif`.
  Hashes (após formatação determinística e reconciliação do manifesto): `report.md` `834ec4d79011771ea76e5595bdb35abf78ac7d2036b6b1fae2a62aba7b7fdc99`;
  `findings.json` `54ff38e7cb1000ec90a137c92762cea9a20d91593caa9633dc4b36d25124a4a3`;
  `coverage.json` `c23c486ea7f53eb82ed1ccdca3d21c4c23534653164b7e0c19e06fb658480052`;
  `scan-manifest.json` `c5d951e250db043f0852a78116d8bbe2179fbd47f9c0bab112f7b6f624096bdc`;
  `results.sarif` `a2aa22410e4392774b174df8694dbc4256186941c7f7e1ae2550d7fd04b3cd45`.

## Revisões independentes posteriores

- Hegel (pós-refatoração, somente leitura): handoff mínimo encontrou risco condicional de
  TTL abaixo do timeout de chamada. A implementação confirmou e corrigiu a condição com
  `MIN_SAFE_RESERVATION_TTL_MS=120000`; não encontrou bypass de gateway ou settlement.
  Hegel não executou testes/build, portanto seu handoff não é evidência de runtime.
- Banach (pós-candidato final, somente leitura): confirmou a ordem `reserveAtomic` →
  `modelCaller`, settlement em `finally` por round, ausência de SQL de orçamento em
  `chat.functions.ts` e canário auth vazio. Identificou `callModelForTests` exportado e
  consumido diretamente por `src/test/model-gateway.test.ts`; não encontrou consumidor
  produtivo nem bypass em produção. A costura permanece residual/test-only e foi mantida
  explicitamente no escopo diferido do scan; Banach não executou testes.
- Noether: nenhuma evidência transferível na janela bounded; conforme C-12, silêncio não
  foi tratado como aprovação, rejeição ou evidência.

## Decisões de Plano aplicadas ou revisadas

- D-02/D-03/D-04/D-06/D-09/D-10 aplicadas no ledger PostgreSQL: `UPDATE` condicional com
  `RETURNING`, `ai_usage` única, guard de status, transação, por-round, sweep lazy e logs
  estruturados.
- D-05 aplicado com os defaults documentados em Q-005. D-13/C-12 aplicado com revisões
  somente leitura e handoffs mínimos.
- Revisão de implementação permitida por C-06: o executor foi separado em
  `chat-execution.server.ts`, helpers de dados ficaram em `chat-data.ts` para não expor
  módulos Node ao bundle browser, e a complexidade/duplicação do harness foi reduzida.
  Essas alterações preservaram REQ-001..011 e foram verificadas no CI do tip final.
- Limitação residual: duas falhas consecutivas de transação durante `settle` podem adiar a
  correção para o sweep por TTL; o retry único reduz a janela, mas não torna uma falha
  operacional dupla impossível. O consumo real dessa janela pode ser perdido na
  contabilidade, e isso permanece explicitamente reportado.
