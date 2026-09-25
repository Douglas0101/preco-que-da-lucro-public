# ADR-026 — Grafo executado da FSM de conversa (poda + reserva explícita de estados)

- Status: **Aceito (ACCEPTED)** — decisão de programa (P1 / S6), caminho (b) "poda + marca reserva", sem mudança de comportamento
- Data: 2026-09-01
- Escopo: `src/lib/chat-fsm.server.ts` (FSM conversacional server-side, WS-06) e sua documentação; nenhum change de transição, schema ou UX
- Originado por: WS-06 (entregue) + pergunta S6 do plano ("qual estado autoriza tools mutantes hoje?")

## Contexto

A WS-06 declarou 7 estados (`idle | collecting_context | calculating | confirming | executing | completed | failed`) em `src/lib/chat-fsm.server.ts:8-18`, espelhados no CHECK do banco (migration `drizzle/0008_workable_professor_monster.sql`, `chat_conversations.conversation_state in (7 valores)`). A V7 §14.2 desenha uma máquina com estágio de confirmação; o plano P1 §14.1/§14.2 (F9) e INV-002/INV-014 exigem allowlist por estado com enforcement server-side.

**Resposta à pergunta S6, com evidência:** o único estado que autoriza tools mutantes hoje é **`collecting_context`**.

- `FSM_STATE_TOOL_ALLOWLIST.collecting_context = REGISTRY_TOOL_NAMES` — todas as 10 tools do registro (`create_product`, `add_ingredients`, `set_ingredient_cost`, `set_yield`, `add_packaging`, `set_price_and_tax`, `add_fee`, `set_market_price`, `add_expense`, `finish_product`; `src/lib/ai/tool-registry.ts:96-315`) — em `src/lib/chat-fsm.server.ts:116`; os demais 6 estados têm allowlist vazia (`:115`, `:117-121`).
- O gate é aplicado em `fsmGuardedToolRunner` (`src/lib/chat-execution.server.ts:284`): a tool só roda se `FSM_STATE_TOOL_ALLOWLIST[state].includes(toolName)` **e** estiver no escopo de produto (`gatewayToolsForState`, `src/lib/ai/tool-registry.ts:367`); permissão (owner/admin `canMutate`) e idempotência continuam no runner guardado.

Contudo, o **grafo executado** pelo fluxo atual alcança apenas 4 estados. Evidência (tabela em `src/lib/chat-fsm.server.ts:43-63`; disparos em `src/lib/chat-execution.server.ts`):

| Aresta executada                                                                 | Tabela                  | Disparo no código                                                                                    |
| -------------------------------------------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `idle →(SUBMIT) collecting_context`                                              | `chat-fsm.server.ts:44` | `chat-execution.server.ts:515-520`                                                                   |
| `collecting_context →(TOOL_EXECUTED) collecting_context` (self-loop)             | `:46`                   | `:362-367`                                                                                           |
| `collecting_context →(FINAL) completed`                                          | `:47`                   | `:373-379` (persistido junto da mensagem assistant, `:380` → `:210`)                                 |
| `collecting_context →(FAILED) failed`                                            | `:48`                   | `:542-547` (best-effort no catch)                                                                    |
| `completed →(SUBMIT) collecting_context` / `failed →(SUBMIT) collecting_context` | `:61-62`                | `:515-520` em turnos seguintes                                                                       |
| `RESET → idle` de qualquer estado                                                | `:44,50,58-62`          | `clearChatHistory` escreve `conversationState: "idle"` diretamente (`src/lib/chat.functions.ts:337`) |

**Verificação da alegação de rejeição de entrada:** na tabela atual (`chat-fsm.server.ts:43-63`) **nenhuma aresta de entrada** aponta para `calculating`, `confirming` ou `executing` — nenhum evento, emitido de qualquer estado, os alcança. As arestas **de saída** desses três estados (`FINAL→completed`, `FAILED→failed`, `RESET→idle`, `:58-60`) existem e são intencionalmente mantidas: são guardas inofensivos caso uma linha seja escrita diretamente nesses estados (futuro M-04 ou intervenção manual) — permitem a saída sem nunca conceder tools (allowlist vazia). Qualquer outro evento nesses estados (p.ex. `SUBMIT`, `TOOL_EXECUTED`) já é inválido: `transitionConversation` não lança, registra a métrica `conversationInvalidTransitions` e retorna o estado inalterado (`chat-execution.server.ts:257-259`). Não há confirmação server-side: o modelo propõe e a mesma requisição executa as mutações; a "confirmação" é puramente conversacional na UX do chat, compensada por INV-009 (chave de idempotência por chamada `${conversationId}:${toolCall.id}` — `chat-execution.server.ts:313` —, ledger `tool_executions` e settle no budget ledger).

O estado `confirming` "de verdade" (protocolo confirmar-antes-mutar com aceitação do usuário persistida server-side) é o tema da **máquina de estados CAS do orçamento em `docs/specs/M-04/spec.md` (DRAFT v2, D-011, §287-315)** — que ainda não tem RAT humano. Escrever o protocolo agora seria escopo proibido pelo §10 do plano P1.

## Opções

### Opção (a) — Conectar os estados reservados agora

Implementar UI de confirmação + execução diferida (`collecting_context → confirming →(CONFIRM) executing →(FINAL) completed`). Rejeitada: exige UI, evento novo, persistência de proposta e aprovação, e depende da máquina CAS de M-04 (DRAFT, sem RAT) — escopo P2, fora do P1 §10.

### Opção (b) — Podar ao grafo executado e marcar reservados (ACEITA)

Manter o vocabulário dos 7 estados (CHECK do banco inalterado — compatibilidade futura), mas declarar documentalmente que o **grafo executado** é `idle / collecting_context / completed / failed` (+ `RESET`), e que `calculating`, `confirming`, `executing` são **RESERVADOS**: inalcançáveis por eventos no fluxo atual, allowlist vazia como _gate negation_ server-side, arestas de saída mantidas como guardas de escrita direta. Anotações `RESERVA (ADR-026)` no código; nenhum change de comportamento.

### Opção (c) — Remover os 3 estados do vocabulário

Enxugar enum/tipo e reescrever o CHECK (migration nova). Rejeitada: custo de migration + rollback para ganho zero de segurança (allowlist já nega tools); perderia a compatibilidade _forward_ com o passo de confirmação futuro do M-04 (escrita direta em valor já aceito pelo banco).

## Decisão

**Opção (b).** O grafo executado da FSM de conversa é:

```
idle ──SUBMIT──▶ collecting_context ──FINAL──▶ completed ──SUBMIT──▶ collecting_context …
                      │  ▲                        failed ──SUBMIT──▶ collecting_context …
            TOOL_EXECUTED (self-loop) │
                      └──FAILED──▶ failed          RESET (de qualquer estado) ──▶ idle
```

`calculating`, `confirming`, `executing` permanecem declarados (vocabulário/CHECK) e são explicitamente **RESERVADOS (ADR-026)**: sem arestas de entrada por evento, allowlist vazia (`chat-fsm.server.ts:117-119`) aplicada por `fsmGuardedToolRunner` (`chat-execution.server.ts:284`), arestas de saída (`FINAL/FAILED/RESET`, `chat-fsm.server.ts:58-60`) mantidas como guardas de escrita direta. Um futuro caminho (a) deve reabrir este ADR e pousar em M-04/P2.

## Consequências

- Nenhum estado inalcanchável novo é apresentado à UI: `conversationStateLabel` (`chat-fsm.server.ts:80-95`) nunca será consultado com os reservados no fluxo executado; as labels ficam documentadas como latentes.
- A confirmação continua conversacional, com compensação idempotente por chamada (INV-009) — o único gate de mutação server-side é `(estado ∈ allowlist) ∧ (escopo do produto) ∧ (permissão) ∧ (idempotência)`, não um estado `confirming`.
- O banco não muda: CHECK 0008 aceita os 7 valores, deixando a porta aberta para escrita futura de `confirming`/`executing` pelo protocolo M-04 sem migration.
- Testes passam a **fixar** o grafo executado e a reserva: sequência executada sem transições inválidas; allowlists vazias dos reservados; comportamento das arestas de saída/diretas dos reservados conforme a tabela.
- Custo: o vocabulário "mayor" que o executado segue existindo; mitigado pela marcação `RESERVA (ADR-026)` em tudo que os declara.

## Referências

- Plano V7 §14.1 (IA não autoriza a própria tool), §14.2 (state machine), §14.4 (allowlist por estado); plano P1 F9/WS-06 e §10 (congelamento de escopo P1)
- INV-002 (validação server-side), INV-009 (mutação atômica/idempotente com compensação), INV-014 (validação runtime de tool) — `docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md:254,261,266`
- `docs/evidence/ws-06-fsm-server-2026-09-01.md` (entrega da FSM), `docs/evidence/s6-fsm-grafo-executado-2026-09-01.md` (esta decisão)
- `docs/specs/M-04/spec.md` (DRAFT v2 — máquina CAS do orçamento; pouso previsto de um protocolo `confirming` futuro)
