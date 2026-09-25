# M-04 — Definition of Done

Status do módulo: `DRAFT v2` (emenda 2026-08-28). A lista abaixo define o que será necessário para
implementar e propor o congelamento; nada nesta lista foi executado pela criação
desta documentação.

## Contratos e arquitetura

- [ ] `BudgetService` e `BudgetRepositoryPort` são portas formais e tenant-scoped.
- [ ] `recordOutcome` existe como operação distinta do settlement e é idempotente.
- [ ] A facade legada `budget-ledger.server.ts` delega sem duplicar regra de negócio.
- [ ] `usageId` por round e `${conversationId}:${toolCall.id}` por replay de tool
      permanecem trilhas de idempotência distintas.
- [ ] Retries internos não fazem nova reserva nem multiplicam `model_call_count`.
- [ ] A política de 429/backoff escolhida em Q-019 está documentada e testada.

## Q-010 e contabilidade

- [ ] O provider outcome e `real_tokens` são persistidos antes do settlement.
- [ ] `recordOutcome` não altera `status`, `tokens_reserved` ou `in_flight`.
- [ ] Settlement é uma transição guardada e idempotente.
- [ ] D-008 define o fencing atômico de `settle` × `expire` sem esconder a
      compatibilidade entre o predicado de claim e o outcome já persistido.
- [ ] D-009 define `settle-after-expire`: uma expiração terminal não é
      sobrescrita por resultado tardio e o caminho tardio é no-op/reconciliação.
- [ ] Crash entre outcome e settlement é recuperado sem perda de tokens reais.
- [ ] Sweep com outcome chama reconciliação/settlement usando o valor persistido.
- [ ] Sweep sem outcome expira como desconhecido e usa `ttl_expired`.
- [ ] Nenhum sweep ou retry realiza dupla baixa de counters.
- [ ] O TTL mínimo de 120 s é validado contra timeout máximo de 60 s.

## Outbox

- [ ] `DomainEventInput` contém chave de idempotência estável.
- [ ] A tabela outbox possui tenant, agregado, payload, timestamps, tentativas,
      erro e índice de pendentes.
- [ ] `(tenant_id, idempotency_key)` é único.
- [ ] Append de domínio e evento ocorre na mesma transação.
- [ ] RLS e grants seguem o padrão tenant-scoped de `ai_usage`.
- [ ] Dispatcher implementa entrega at-least-once e mantém evento pendente quando
      a entrega falha.
- [ ] Consumidores deduplicam; não existe claim de exactly-once.

## Testes mínimos

- [ ] Reserva rejeitada não chama o gateway e não deixa append parcial.
- [ ] Limites de chat, tokens, chamadas e in-flight são aplicados atomicamente.
- [ ] Sucesso sem tool grava tokens, outcome, counters e status corretos.
- [ ] Tool round cria novo `usageId` e mantém o round anterior liquidado uma vez.
- [ ] Retry do gateway reutiliza o mesmo `usageId`.
- [ ] `429`, timeout e abort têm outcome/falha separados e settlement verificado.
- [ ] Replay idempotente de tool não executa novamente; hash divergente dá conflito.
- [ ] Retry de settlement após commit perdido é no-op seguro.
- [ ] Dois sweeps concorrentes não duplicam decrementos.
- [ ] As células F-21 (`settle × expire`) e F-22 (`settle-after-expire`) têm
      teste concorrente ou justificativa `UNKNOWN` explícita.
- [ ] Crash simulado depois de `recordOutcome` é reconciliado pelo sweep.
- [ ] Crash simulado antes de `recordOutcome` expira sem afirmar consumo real.
- [ ] Outbox append repetido devolve evento existente e não cria duplicata.
- [ ] Falha de publish deixa evento pendente e permite retry.
- [ ] Testes de tenant/RLS impedem leitura e escrita cross-tenant.
- [ ] O conjunto existente T1–T10 é reexecutado no checkout da implementação.

## Banco e evidência

- [ ] `db:test` executa com PostgreSQL 17 e `DATABASE_DRIVER=node-postgres`.
- [ ] Migration, grants, checks e RLS são verificados sem usar produção.
- [ ] Runtime continua com `DATABASE_URL`; `DATABASE_ADMIN_URL` não é injetada no
      processo web.
- [ ] Cada execução registra SHA, branch/ref, driver, ambiente, comando e saída.
- [ ] CI/Neon somente são atribuídos ao SHA exato que executou o workflow.
- [ ] Falhas remotas, checks skipped e credenciais ausentes permanecem explícitos.
- [ ] O gate de harness D-010 verifica oito tentativas de reserva, dois
      admitidos, dois sucessos, seis rejeições `AI_QUOTA` e counters finais
      zerados, sem relaxar as asserções de E6.

## Segurança e operação

- [ ] O diff executável de M-04 recebe revisão de segurança escopada.
- [ ] Nenhum segredo aparece em logs, payloads, artefatos ou eventos.
- [ ] Não há acesso direto de server function ao schema fora da allowlist M-02.
- [ ] Nenhuma migration, publicação, cutover ou alteração de produção é feita como
      parte do DoD local.
- [ ] O scan parcial do M-01 não é apresentado como cobertura do código novo.

## Critério de promoção

O módulo só pode sair de `DRAFT` quando:

1. Q-019 aprovar D-001..D-010, incluindo a resolução da compatibilidade entre
   D-004 e D-008;
2. a matriz de falhas estiver coberta por teste ou por `UNKNOWN` explicitamente
   justificado;
3. os contratos e migrations estiverem revisados;
4. o código e os testes passarem no SHA publicado correspondente;
5. um RAT humano registrar o congelamento.

---

## Emenda v2 — 2026-08-28 (SDD v5.2 §8.1): DoD G1–G8 para P9

Achados adversariais de P4 convertidos em requisitos. Todos os itens são
obrigatórios para o DoD de P9 (implementação somente após Q-019):

- [ ] G1 — sweep opera por `status`: expira `RESERVED` e liquida `COMPLETED`
      usando o `real_tokens` da linha.
- [ ] G2 — `recordOutcome` runtime com CAS (`RESERVED` → `COMPLETED`);
      `affected=0` registra F-21 (late outcome).
- [ ] G3 — matriz de crash testada ponto a ponto (ver `failure-matrix.md`).
- [ ] G4 — `settle` não aceita valor crítico do chamador; usa o valor da linha.
- [ ] G5 — TTL avaliado pelo relógio do banco (`now()`/`statement_timestamp()`),
      nunca pelo relógio da aplicação.
- [ ] G6 — late outcome runtime completo: outcome tardio sobre `EXPIRED` grava
      `late_outcome=true` com budget inalterado (F-21).
- [ ] G7 — evento de settlement somente quando `affected=1`; re-drive sobre
      `SETTLED` é no-op com zero eventos duplicados.
- [ ] G8 — suíte concorrente real dock-based, com ≥2 conexões independentes e
      barreiras de sincronização.

Métrica associada: M04-1 = 0.
