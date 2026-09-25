# M-04 — Matriz de falhas e recuperação

Status: `DRAFT v2` (emenda 2026-08-28). Esta matriz é o registro operacional de D-006 e deverá ser
aprovada no congelamento Q-019. `OBSERVED` descreve o checkout atual; `PLANNED`
descreve o comportamento alvo; `NOT-IMPLEMENTED` identifica lacunas que não podem
ser apresentadas como corrigidas.

| Célula | Evento                                    | Estado observado                                                                                                                              | Comportamento planejado                                                                                     | Verificação obrigatória                                                |
| ------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| F-01   | Reserva de chat rejeitada                 | `reserveChatInTransaction` falha com quota antes de abrir o fluxo de conversa — `OBSERVED` em `conversation.service.ts:101-112`               | Nenhum round de modelo é criado; resposta `AI_QUOTA`; transação não deixa append parcial                    | quota de chat, rollback e ausência de mensagem parcial                 |
| F-02   | Reserva de round rejeitada                | `reserveAtomic` aplica sweep e rejeita quando limite diário, tokens ou in-flight excedem — `CODE-PROVED` em `budget-ledger.server.ts:268-322` | Nenhum gateway call antes da reserva; retorno `AI_QUOTA`                                                    | limite de tokens, limite de chamadas e limite de in-flight             |
| F-03   | Provider retorna sucesso sem tool         | Tokens são coletados e settlement ocorre no `finally` — `OBSERVED` em `chat-execution.server.ts:248-278`                                      | `recordOutcome` durável antes da finalização; settlement único; mensagem persistida                         | tokens reais, outcome `success`, counters e status terminal            |
| F-04   | Provider retorna tool calls               | Round termina como `tool_round` e abre novo round — `CODE-PROVED` em `chat-execution.server.ts:254-268`                                       | Primeiro round conserva seu `usageId`; cada novo round possui outro `usageId`                               | round number, duas reservas e uma liquidação por round                 |
| F-05   | Retry transitório do gateway              | Retries transitórios usam a mesma execução de `callModel`; nova reserva não aparece no fluxo — `OBSERVED` em `chat.functions.ts:148-240`      | Reutilizar `usageId`; contar uma admissão de modelo; não multiplicar tokens reservados                      | duas tentativas, um usage row e um settlement                          |
| F-06   | `429 RATE_LIMIT`                          | `RATE_LIMIT` é lançado e não é retryado automaticamente — `CODE-PROVED` em `chat.functions.ts:144-154`                                        | Default D-003: falha separada, sem nova reserva, admissão não reembolsada e tokens reais quando disponíveis | verificar contagem e alternativa escolhida no Q-019                    |
| F-07   | Timeout/aborto                            | Abort pode sair pelo `catch` e chegar ao `finally` — `OBSERVED` em `chat-execution.server.ts:248-278`                                         | Registrar outcome de timeout e liquidar/reconciliar uma única vez                                           | signal abortado, settlement e nenhum in-flight órfão após recuperação  |
| F-08   | Falha de tool                             | Tool grava `failed` e auditoria de falha — `CODE-PROVED` em `tool-runner.ts:198-217`                                                          | Preservar tokens já conhecidos; refinar outcome antes do settlement quando possível                         | estado da tool, auditoria e counters do round                          |
| F-09   | Replay idempotente de tool                | Claim existente devolve resultado ou conflito por hash — `CODE-PROVED` em `tool-runner.ts:125-165`                                            | Não executar novamente; chave `${conversationId}:${toolCall.id}` não é `usageId`                            | mesmo hash gera replay; hash diferente gera conflito                   |
| F-10   | Crash antes de `recordOutcome`            | Hoje sweep expira com zero — `CODE-PROVED`/`NOT-IMPLEMENTED` em `budget.repository.ts:64-114`                                                 | Sweep grava `ttl_expired` e zero, pois não há outcome confirmado                                            | reserva termina como expired e counters são liberados uma vez          |
| F-11   | Crash depois de outcome e antes de settle | Não há hoje escrita separada — `NOT-IMPLEMENTED`; Q-010 é o residual                                                                          | Sweep encontra `outcome IS NOT NULL` e chama reconciliação com `real_tokens` persistidos                    | consumo real preservado e ausência de dupla baixa                      |
| F-12   | Cliente perde resposta após commit        | Settlement possui retry único guardado — `CODE-PROVED` em `budget-ledger.server.ts:325-365`                                                   | Repetição retorna aplicação única ou no-op terminal                                                         | repetir settlement não decrementa counters duas vezes                  |
| F-13   | Sweep concorrente                         | Atualização atual filtra `status = 'reserved'` — `OBSERVED`                                                                                   | Claims devem ser guardados; somente uma transação libera a reserva; expiração exige `outcome IS NULL`       | dois sweeps concorrentes, uma transição e counters consistentes        |
| F-14   | TTL abaixo do seguro                      | Configuração rejeita TTL abaixo de 120000 ms — `CODE-PROVED` em `budget-ledger.server.ts:147-176`                                             | Manter invariante `TTL >= 2 x timeout máximo de request`                                                    | valores 119999 e 120000 ms                                             |
| F-15   | Tenant incorreto ou ausente               | Contexto transacional aplica identidade/tenant/roles — `CODE-PROVED` em `client.server.ts` e RLS                                              | Toda reserva, outcome, settlement, sweep e evento usa tenant autenticado                                    | leitura/escrita cross-tenant deve falhar                               |
| F-16   | Outbox append duplicado                   | Outbox ainda não existe — `NOT-IMPLEMENTED` em `event.contracts.ts:12-18`                                                                     | Unique `(tenant_id, idempotency_key)` retorna evento existente sem duplicar                                 | append repetido retorna `duplicate = true`                             |
| F-17   | Outbox publish falha                      | Não há dispatcher implementado — `NOT-IMPLEMENTED`                                                                                            | Evento permanece pendente com tentativa/erro; retry pode duplicar entrega                                   | consumer idempotente e evento não perdido                              |
| F-18   | Consumidor recebe duplicata               | Sem consumidor no checkout — `UNKNOWN`                                                                                                        | Consumidor deduplica por `eventId`/chave estável; exactly-once não é prometido                              | duas entregas, um efeito externo                                       |
| F-19   | Falha de migration/grant/RLS              | `ai_usage` tem grants e policy atuais — `CODE-PROVED` em `drizzle/0006_loud_lockjaw.sql:25-35`                                                | Outbox seguirá o mesmo fail-closed tenant-scoped; migration não roda em produção nesta onda                 | `db:test`, grants, RLS e rollback                                      |
| F-20   | E6 burst de in-flight                     | Run `33080843742` falhou em `gatewayCalls <= 2` com `false !== true` no SHA publicado `develop@12c90a1` — `ARTIFACT-REPORTED`                 | Tratar separadamente em M-06; não relaxar a asserção; imprimir counts e usar hold determinístico            | oito requests, `gatewayCalls`, `peakActiveCalls`, sucessos e rejeições |
| F-21   | `settle × expire`                         | Settlement e sweep atuais usam transições separadas e não possuem claim explícito entre outcome e status — `NOT-IMPLEMENTED`                  | Um claim tenant-scoped vence uma vez; o perdedor relê o estado e não decrementa counters                    | concorrência controlada, uma transição terminal e counters uma vez     |
| F-22   | `settle-after-expire`                     | Resultado tardio não tem semântica documentada além do no-op por status — `NOT-IMPLEMENTED`                                                   | Expiração confirmada permanece terminal; resultado tardio é no-op/reconciliação, sem sobrescrever outcome   | expirar, liquidar depois e verificar status/outcome/counters           |

## Regras invariantes

1. Nunca há gateway call antes de uma reserva de round aceita.
2. Um retry interno do mesmo round não cria `usageId` adicional.
3. Uma tool replayada não executa novamente e não cria reserva de orçamento.
4. `recordOutcome` não libera reserva; `settle` não inventa consumo real.
5. Toda transição terminal é guardada por tenant e status atual.
6. Toda liberação de `tokens_reserved` e `in_flight` ocorre no máximo uma vez.
7. O sweep não converte `outcome IS NOT NULL` em `ttl_expired`.
8. `reservationTtlMs >= 120000` e o timeout máximo do request é 60000 ms.
9. Outbox é at-least-once, com consumidores idempotentes.
10. `settle` e `expire` não podem ambas vencer a mesma reserva; a condição de
    claim deve ser compatível com a escrita prévia de `outcome` definida em D-004.
11. Falha, ausência de evidência ou ausência de credencial é registrada como
    `FAILED`, `NOT-EXECUTED`, `BLOCKED` ou `UNKNOWN`, nunca como sucesso implícito.

---

## Emenda v2 — 2026-08-28 (SDD v5.2 §8.1): matriz de crash (G3)

| Ponto de crash                      | Recuperação planejada (D-011)                      |
| ----------------------------------- | -------------------------------------------------- |
| pós-reserve / pré-execução          | sweep expira (`RESERVED` → `EXPIRED`)              |
| pós-resultado / pré-`recordOutcome` | expira + replay (D-003) pode re-executar tool      |
| pós-`recordOutcome` / pré-settle    | sweep ou re-drive settle (`COMPLETED` → `SETTLED`) |
| pós-commit settle+outbox (mesma tx) | nada a recuperar                                   |
| mid-sweep                           | re-run idempotente por CAS                         |

Chegadas tardias (D-009 estrito), alinhadas a F-21/F-22:

- outcome → `EXPIRED`: registra + `late_outcome=true`; budget inalterado (F-21).
- settle → `EXPIRED`: rejeita idempotentemente + evento de auditoria (F-22).
- re-drive sobre `SETTLED`: no-op (0 linhas), zero eventos duplicados (G7).

Regra invariante adicional: toda transição é CAS por linha; sob READ COMMITTED
o predicado é reavaliado contra a versão commitada (EvalPlanQual), garantindo
exatamente um gravador por transição.
