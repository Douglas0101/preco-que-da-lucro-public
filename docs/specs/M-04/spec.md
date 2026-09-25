# M-04 — Orquestração de orçamento, outcome durável e outbox

Status: `DRAFT v2` (emenda 2026-08-28 — SDD v5.2 §8.1) até RAT humano e
congelamento em Q-019. Este documento define a
intenção e os contratos do módulo; não autoriza implementação, migration, merge,
publicação, acesso Neon ou cutover.

## Origem e classificação da evidência

Esta versão usa o RAT SA-12/Bayes, o código do checkout atual e a correção de
matriz prevista no C4. Cada afirmação deve permanecer com uma das classificações
abaixo:

- `CODE-PROVED`: comportamento verificável no código/schema atual;
- `OBSERVED`: comportamento observado no fluxo atual, ainda sujeito a contrato;
- `ARTIFACT-REPORTED`: resultado registrado em CI, readiness ou evidência histórica;
- `PLANNED`: desenho proposto por esta spec;
- `NOT-IMPLEMENTED`: lacuna identificada no checkout atual;
- `UNKNOWN`: não comprovado pelo material disponível.

### Fatos que fundamentam o draft

- `ai_usage` já contém `usage_id`, `round_no`, `status`, `reserved_at`,
  `settled_at`, `real_tokens` e `outcome` — `CODE-PROVED` em
  [`src/db/schema.ts:741-767`](/home/douglas-souza/preco-que-d-main/src/db/schema.ts:741).
- A reserva de chat ocorre na transação que carrega a conversa, valida o produto,
  grava a mensagem do usuário e carrega o histórico — `CODE-PROVED` em
  [`src/server/services/conversation.service.ts:95-124`](/home/douglas-souza/preco-que-d-main/src/server/services/conversation.service.ts:95).
- Cada round de modelo faz uma reserva própria com `kind` e `roundNo`; retries
  internos do gateway não criam nova reserva — `OBSERVED` no fluxo composto de
  [`src/lib/chat.functions.ts:112-240`](/home/douglas-souza/preco-que-d-main/src/lib/chat.functions.ts:112) e
  [`src/lib/chat-execution.server.ts:281-324`](/home/douglas-souza/preco-que-d-main/src/lib/chat-execution.server.ts:281).
- O round atual liquida no `finally`, usando o mesmo `usageId`; o repository faz
  a transição guardada `reserved → settled` e atualiza os contadores —
  `CODE-PROVED` em [`src/lib/chat-execution.server.ts:210-278`](/home/douglas-souza/preco-que-d-main/src/lib/chat-execution.server.ts:210) e
  [`src/server/repositories/budget.repository.ts:183-231`](/home/douglas-souza/preco-que-d-main/src/server/repositories/budget.repository.ts:183).
- O replay de tool usa a chave `${conversationId}:${toolCall.id}`, com hash de
  request e estados de claim/execution; essa chave é distinta de `usageId` —
  `CODE-PROVED` em [`src/lib/chat-execution.server.ts:136-149`](/home/douglas-souza/preco-que-d-main/src/lib/chat-execution.server.ts:136) e
  [`src/lib/ai/tool-runner.ts:125-219`](/home/douglas-souza/preco-que-d-main/src/lib/ai/tool-runner.ts:125).
- O TTL padrão é 120 s e o timeout máximo do request de chat é 60 s —
  `CODE-PROVED` em [`src/lib/ai/budget-ledger.server.ts:13-25`](/home/douglas-souza/preco-que-d-main/src/lib/ai/budget-ledger.server.ts:13) e
  [`src/lib/ai/budget-ledger.server.ts:147-153`](/home/douglas-souza/preco-que-d-main/src/lib/ai/budget-ledger.server.ts:147).
- A implementação atual do sweep expira toda reserva vencida, grava zero e
  `ttl_expired`; não existe ainda a ramificação por `outcome IS NOT NULL` —
  `CODE-PROVED` e `NOT-IMPLEMENTED` em
  [`src/server/repositories/budget.repository.ts:64-114`](/home/douglas-souza/preco-que-d-main/src/server/repositories/budget.repository.ts:64).
- A implementação atual grava `status`, `real_tokens` e `outcome` na mesma
  operação de settlement — `CODE-PROVED` em
  [`src/server/repositories/budget.repository.ts:183-231`](/home/douglas-souza/preco-que-d-main/src/server/repositories/budget.repository.ts:183).
- O outbox ainda é apenas contrato: não há tabela, migration, repository ou
  service executável no checkout — `CODE-PROVED`/`NOT-IMPLEMENTED` em
  [`src/server/contracts/event.contracts.ts:4-18`](/home/douglas-souza/preco-que-d-main/src/server/contracts/event.contracts.ts:4).

## Objetivo

Formalizar uma trilha de orçamento que sobreviva a falhas entre o conhecimento do
resultado do provedor e a liquidação contábil, sem contar duas vezes retries ou
tools replayadas, e definir um outbox tenant-scoped para eventos at-least-once.

O módulo deve conservar as fronteiras existentes:

```text
server function
  -> BudgetService / ConversationService / ChatExecution
  -> BudgetRepositoryPort / EventRepositoryPort
  -> PostgreSQL tenant-scoped
```

Server functions não recebem acesso direto ao schema/Drizzle. Runtime continua
usando `DATABASE_URL` pooled; `DATABASE_ADMIN_URL` permanece reservado a
migrations, setup e operações administrativas controladas.

## Contratos propostos

Os contratos abaixo são `PLANNED`. A implementação de W2 deverá preservar os
tipos públicos já utilizados pela facade e introduzir as portas formais de M-04.

```ts
export type BudgetOutcomeRecord = {
  usageId: string;
  realTokens: number;
  outcome: string;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
};

export type OutcomeWriteResult = "recorded" | "already_recorded" | "not_found" | "not_reserved";

export interface BudgetRepositoryPort {
  /** Idempotente; não altera tokens_reserved nem in_flight. */
  recordOutcome(
    transaction: DatabaseTransaction,
    tenantId: string,
    record: BudgetOutcomeRecord,
  ): Promise<OutcomeWriteResult>;
}

export interface BudgetService extends BudgetLedger {
  /** Primeiro passo da contabilidade durável. */
  recordOutcome(record: BudgetOutcomeRecord, options?: { now?: Date }): Promise<OutcomeWriteResult>;
}
```

`BudgetRepositoryPort` deverá também formalizar, sem mudança semântica, as
operações existentes de reserva, settlement e sweep. Os tipos atuais
`ReservedUsage`, `SettlementResult` e `SweepResult` são a base de compatibilidade.
A facade `budget-ledger.server.ts` poderá continuar exportando a superfície legada,
mas deverá delegar para `BudgetService` quando a implementação for feita.

O resultado de `recordOutcome` é idempotente: repetir a mesma escrita para o mesmo
`usageId` não pode duplicar contadores. A operação só aceita registro ainda
`reserved`; um registro terminal não deve ser reaberto.

## Semântica de round, retry e idempotência

### Round e retry do gateway

1. A reserva de chat é uma unidade de conversa e continua distinta das reservas
   de modelo.
2. Cada round de modelo recebe um único `usageId`.
3. Retries internos do gateway pertencem ao mesmo round e reutilizam esse
   `usageId`; não fazem nova reserva nem multiplicam `model_call_count`.
4. Um novo round após tool call recebe novo `usageId` e novo `roundNo`.
5. O máximo atual de rounds continua sendo oito até decisão posterior explícita.
6. A admissão do round já incrementa a contagem de chamada de modelo. Um erro
   posterior não devolve essa admissão automaticamente.

### Tool replay

`usageId` responde pela contabilidade do round. A chave
`${conversationId}:${toolCall.id}` responde pelo replay da execução da tool. O
hash do request permanece parte da proteção: mesma chave com argumentos diferentes
é conflito; mesma chave com resultado persistido pode ser replayada sem executar de
novo.

### Resultado do provedor e resultado da aplicação

Quando o provedor retornar, o serviço deverá gravar `real_tokens`, breakdown e um
outcome durável antes de executar efeitos que ainda possam falhar. Se uma etapa
posterior de tool ou persistência produzir erro, o outcome poderá ser refinado
enquanto o registro permanecer `reserved`, preservando os tokens conhecidos. O
settlement não poderá substituir um valor conhecido por zero.

Valores de `outcome` continuam textuais nesta etapa. A implementação deverá
catalogar os valores já emitidos (`success`, `tool_round`, erros mapeados e
`ttl_expired`) antes de propor enumeração ou renomeação.

## Q-010 — outcome durável em dois passos

O fluxo normativo proposto é:

```text
reserve round
  -> provider outcome conhecido
  -> recordOutcome(usageId, realTokens, outcome, breakdown)
  -> tool/persistência/finalização
  -> settle(usageId)
```

### Passo 1 — `recordOutcome`

Executar uma atualização equivalente a:

```sql
UPDATE ai_usage
SET outcome = :outcome,
    real_tokens = :real_tokens
WHERE usage_id = :usage_id
  AND tenant_id = :tenant_id
  AND status = 'reserved';
```

O breakdown usado nos contadores deverá ser mantido no contexto da operação ou
persistido conforme o desenho final do repository; não poderá ser inventado pelo
sweep. Esta atualização:

- deve ser tenant-scoped;
- deve ser idempotente;
- não altera `status`;
- não decrementa `tokens_reserved`;
- não decrementa `in_flight`;
- não marca a unidade como liquidada.

### Passo 2 — settlement

`settle` deverá ser uma transição guardada de uma reserva ainda aberta. Sua
responsabilidade é liberar `budget_tokens`/`in_flight`, aplicar os contadores de
tokens e tools e marcar o status terminal. A repetição após erro de transporte ou
commit já ocorrido deve resultar em aplicação única ou no-op terminal.

### Sweep reconciliador

Para uma reserva cujo TTL venceu:

- `status = 'reserved'` e `outcome IS NOT NULL`: liquidar usando o
  `real_tokens` durável e o outcome armazenado;
- `status = 'reserved'` e `outcome IS NULL`: expirar como desfecho desconhecido,
  com `real_tokens = 0` e `outcome = 'ttl_expired'`;
- qualquer caminho deve liberar a reserva uma única vez;
- nenhum caminho deve reabrir registro `settled` ou `expired`.

O crash entre os dois passos deve deixar o consumo real recuperável pelo sweep.
Crash antes do primeiro passo continua sendo explicitamente contabilizado como
desfecho desconhecido, não como consumo confirmado.

## Política de 429, backoff e falhas

O comportamento atual de `429` é `RATE_LIMIT` e não é um retry transitório
automático — `CODE-PROVED` em [`src/lib/chat.functions.ts:144-154`](/home/douglas-souza/preco-que-d-main/src/lib/chat.functions.ts:144).

Default proposto para D-003, ainda `AGENT-PROPOSED`:

- não criar uma nova reserva durante backoff/retry do mesmo round;
- considerar a admissão do round consumida em `model_call_count`;
- registrar um contador/outcome de falha separado;
- gravar tokens reais se o provedor fornecer uso; na ausência de uso, gravar zero;
- liberar `tokens_reserved` e `in_flight` no settlement final;
- não devolver a admissão da chamada para permitir uma nova tentativa ilimitada.

O congelamento deverá comparar esse default com as alternativas “devolver toda a
admissão” e “consumir também a reserva estimada de tokens”. A escolha humana deve
ser registrada em Q-019 antes da implementação.

## Outbox de domínio

O outbox é separado da contabilidade de `ai_usage`. A proposta parte de
[`src/server/contracts/event.contracts.ts:4-18`](/home/douglas-souza/preco-que-d-main/src/server/contracts/event.contracts.ts:4):

```ts
export interface DomainEventInput {
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

export interface AppendEventResult {
  eventId: string;
  duplicate: boolean;
}

export interface EventRepositoryPort {
  append(
    context: RequestContext,
    input: DomainEventInput,
    executor?: Executor,
  ): Promise<AppendEventResult>;
  publishPending(context: RequestContext, executor?: Executor): Promise<number>;
}
```

A migration futura deverá criar uma tabela tenant-scoped com `id`, `tenant_id`,
tipo/agregado, `idempotency_key`, payload JSON, `occurred_at`, `published_at`,
tentativas e último erro. A chave `(tenant_id, idempotency_key)` deverá ser única e
eventos pendentes deverão ter índice próprio. Grants e RLS devem seguir o padrão
de `ai_usage`, documentado em [`drizzle/0006_loud_lockjaw.sql:25-35`](/home/douglas-souza/preco-que-d-main/drizzle/0006_loud_lockjaw.sql:25).

O produtor deverá gravar a mudança de domínio e o evento na mesma transação. O
dispatcher poderá publicar mais de uma vez; somente consumidores idempotentes
podem transformar essa entrega em efeito externo. A spec não promete exactly-once.

## Segurança e isolamento

- Toda operação recebe tenant da identidade autenticada e do contexto transacional;
  header/body não é autoridade isolada.
- `ai_usage`, orçamento diário e outbox devem manter RLS e grants mínimos.
- `usageId` e idempotency keys não podem ser aceitos de outro tenant.
- Payload de outbox não deve carregar segredo, token de gateway ou conteúdo não
  necessário ao consumidor.
- `DATABASE_URL` é runtime; `DATABASE_ADMIN_URL` é migration/admin/setup.
- Nenhuma implementação desta spec acessa produção, altera cutover ou contorna o
  workflow de readiness.

## Dependências e não-escopo

M-04 depende dos contratos e fronteiras de M-02, mas o código de Q-010, a tabela
outbox, migrations, dispatcher e consumers pertencem à implementação posterior.
Esta spec não congela M-02, não reabre SA-01, não altera ADR-021 e não resolve a
falha E6; E6 é tratado como cenário de admissão concorrente em M-06.

---

## Emenda v2 — 2026-08-28 (SDD v5.2 §8.1): máquina de estados do budget (D-011)

Esta emenda transcreve o conteúdo canônico do SDD v5.2 §8.1. O documento passa
a `DRAFT v2`: nada aqui autoriza implementação, migration, merge, publicação,
acesso Neon ou cutover; o congelamento permanece gate humano em Q-019.

### Nota de fidelidade das referências (pós-S1)

As citações `CODE-PROVED` desta spec foram escritas contra a árvore que continha
a extração M-02 (commit `477707d`). Na rodada S1 (2026-08-28) esse commit foi
removido da branch (preservado em `wip/m02-extraction`); em consequência:

- arquivos existentes apenas no WIP — `src/server/services/conversation.service.ts`,
  `src/server/repositories/budget.repository.ts`, `src/server/contracts/*.ts`,
  `src/lib/calculation-result.ts` — não existem na árvore commitada da branch;
  citações a eles passam a `ARTIFACT-REPORTED` (válidas contra
  `wip/m02-extraction` @ `477707d`) até o P10;
- arquivos reescritos pelo WIP (`budget-ledger.server.ts`, `tool-runner.ts`,
  `chat-execution.server.ts`, `chat.functions.ts`, `chat-data.ts`,
  `query-options.ts`) existem na branch, mas as linhas citadas refletem a
  versão WIP; revalidar linha a linha no P10;
- `src/db/schema.ts` e `drizzle/` não foram tocados pelo WIP e permanecem
  `CODE-PROVED` (reverificado em 2026-08-28: `ai_usage` em
  `src/db/schema.ts:741-767`).

### D-011 — máquina de estados (resolve D-004 × D-008)

`outcome IS NULL` literal (D-008) confunde "sem resultado" e "outcome gravado,
settle em voo", contra D-004. Solução canônica: estados explícitos com CAS por
linha.

```text
RESERVED ──recordOutcome──▶ COMPLETED ──settle(app|sweep)──▶ SETTLED
    └───────expire(sweep, TTL)───────▶ EXPIRED
```

```sql
-- reserve (idempotente por usage_id)
INSERT INTO budget_reservation (usage_id, ..., status, ttl_deadline)
VALUES (:usage_id, ..., 'RESERVED', statement_timestamp() + make_interval(secs => :ttl))
ON CONFLICT (usage_id) DO NOTHING;

-- recordOutcome (D-004 preservado como transição própria)
UPDATE budget_reservation SET status='COMPLETED', outcome=:o, real_tokens=:rt
WHERE usage_id=:u AND status='RESERVED';

-- settle (exatamente um vence; ledger ajustado NA MESMA transação; valor da LINHA, não do chamador — G4)
UPDATE budget_reservation SET status='SETTLED', settled_at=statement_timestamp()
WHERE usage_id=:u AND status='COMPLETED';

-- expire (relógio do banco — G5; nunca expira COMPLETED)
UPDATE budget_reservation SET status='EXPIRED'
WHERE status='RESERVED' AND now() > ttl_deadline;
```

Mapeamento para o schema vigente (`PLANNED`): a tabela física atual é
`ai_usage` (já contém `usage_id`, `status`, `real_tokens`, `outcome`,
`settled_at`, `reserved_at`); `ttl_deadline` e `late_outcome` são colunas novas
da migration de P9, junto com a adequação dos valores de `status`
(`reserved`→`RESERVED`, etc.), conforme o congelamento Q-019.

### Chegadas tardias (D-009 estrito)

- outcome → `EXPIRED`: registra + `late_outcome=true` para auditoria; budget
  inalterado (F-21);
- settle → `EXPIRED`: rejeita idempotentemente + evento de auditoria (F-22);
- re-drive sobre `SETTLED`: 0 linhas = no-op, zero eventos duplicados (G7).

Fundamento: sob READ COMMITTED, UPDATE que bloqueia em linha concorrente
reavalia o predicado contra a versão commitada (EvalPlanQual, docs PostgreSQL)
→ exatamente um gravador por transição.

### Matriz de crash (G3) e DoD G1–G8

Ponto a ponto na emenda v2 de `failure-matrix.md`; requisitos de P9 na emenda
v2 de `definition-of-done.md`.
