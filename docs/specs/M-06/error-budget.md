# M-06 — Error budget (§30)

**Status:** DRAFT
**Congelamento:** Q-020
**Origem:** Plano Mestre §30 (`docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md:1910`)
e `docs/evidence/plan-partials-2026-09-13/part-3-observabilidade.md` (§30)
**Depende:** baseline M-06 (`EXECUTION-STATE-PROGRAM.md:443`; M-06 segue DRAFT/PENDING)

Este documento define as classes e tolerâncias **candidatas** do error budget. Nenhuma
tolerância aqui é promessa ou SLO: a ratificação exige o baseline M-06 e o carimbo Q-020.
Nada recebe rótulo CONTROLADO antes disso.

## 1. Escopo e não-objetivo

- Mede falhas **do usuário** (envelope `request.completed`/`request.failed`) e o sinal de
  cálculo financeiro (`app.financial.states{state=invalid}`), agregando por `code` na janela.
- Não substitui métricas de backend (OTEL) nem o baseline de latência/pool de M-06.
- Não cria gate de CI nesta fase: `scripts/obs/error-budget.ts` é local-first e não roda na
  pipeline; a promoção a gate exige ADR e ratificação em Q-020.
- Taxonomia de códigos: `docs/adr/ADR-022-error-taxonomy-observability.md`. Degradação
  graciosa com IA indisponível: Plano Mestre §31 — o produto continua sem chat.

## 2. Classes e tolerâncias (DRAFT)

| Classe                        | Sinal                                                                                                                                 | Tolerância candidata                           | Estado                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------------------------- |
| Financeiro crítico            | `app.financial.states{state=invalid}` em caminho do usuário                                                                           | **0** (zero estrutural)                        | proposta                  |
| `incomplete` (dado faltante)  | `app.financial.states{state=incomplete}`                                                                                              | não consome budget — **monitorado**            | observado                 |
| IA transitória                | `request.failed` `AI_TIMEOUT`/`DEPENDENCY_ERROR` de chat + `app.ai.timeouts`                                                          | **1% em 7 d** sobre requisições de chat        | **somente após baseline** |
| Falha de servidor/dependência | `DATABASE_ERROR`/`INTERNAL_ERROR`/5xx de qualquer caminho                                                                             | **0** (zero estrutural, revisível no baseline) | proposta                  |
| Excluídos (não consomem)      | `VALIDATION_ERROR`, `AUTHENTICATION_ERROR`, `AUTHORIZATION_ERROR`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMIT`, `AI_QUOTA` e 4xx concluídos | —                                              | ADR-022                   |

Racional:

- **Financeiro crítico = zero** porque `invalid` significa número corrompido/inconsistente no
  caminho do usuário — nenhum volume de tráfego torna isso aceitável (Plano Mestre §30).
- **`incomplete` não consome**: ausência de dado é estado legítimo de produto (orienta o
  usuário a preencher), mas a série é monitorada para detectar regressão de seed/dado.
- **IA transitória é a única classe com tolerância > 0**: chat tem dependência externa e
  fallback (§31: o app segue 100% sem IA). A taxa de 1% em 7 d é candidata; só vale depois
  do baseline M-06 ratificado (`--baseline=<ref>`), nunca antes.
- **`DATABASE_ERROR`/`INTERNAL_ERROR`/5xx = zero** até o baseline dizer o contrário: são
  falhas de disponibilidade no envelope, e o custo de falso positivo é uma investigação.
- **4xx de validação/auth e cota de IA ficam fora**: entrada inválida, falta de permissão e
  quota atingida (429 não-retryable) não medem disponibilidade do serviço (ADR-022 §2/§8).

## 3. Medição mínima

`scripts/obs/error-budget.ts` (local-first, sem dependência nova):

- entrada: JSONL em `--input=<arquivo>` ou stdin; aceita os eventos de log
  `request.completed`/`request.failed`/`ai.*` (`src/lib/structured-logger.ts:43-59`) e,
  opcionalmente, linhas de métrica exportadas `app.financial.states` e `app.ai.timeouts`;
- janela: `--window=<s|m|h|d>` (default `7d`), ancorada no último `timestamp` do input —
  determinística para fixture e para export;
- agrega por `code` dentro da janela e calcula consumo vs tolerância por classe;
- saída: `docs/evidence/error-budget-<janela>.md` (`--out` para override), com veredito
  `OK`/`FAIL`/`INSUFFICIENT`/`INDETERMINATE` e `exit 0/1/2`;
- **falha fechada**: `N < --min-requests` (default 100) → `INSUFFICIENT` e exit 2; classe
  sem sinal (ex.: financeiro sem linhas de métrica) → `UNKNOWN`; IA sem baseline ratificado
  → `DRAFT`. Nenhum desses caminhos emite verde.

Detalhes de apuração e escalonamento: `docs/runbooks/slo-error-budget.md`.

## 4. Limitações conhecidas

- Hoje `app.financial.states` é um counter OTEL (não é log). Enquanto a série não for
  exportada para JSONL, a classe financeira é `UNKNOWN` e o veredito geral fica
  `INDETERMINATE` (fail-closed). O runbook descreve o export.
- `DEPENDENCY_ERROR` só entra na classe de IA quando o `correlationId` aparece em um evento
  `ai.*` ou o `pathname` contém `chat`; fora disso vira `server_fault`.
- `request.failed` sem `code` é tratado como `UNKNOWN_ERROR` na classe de servidor
  (fail-closed), nunca como excluído.
- Consumo de IA usa `max(falhas de envelope, app.ai.timeouts)` para não subcontabilizar
  abortos que não geram `request.failed`.
- `--min-requests` é um piso de amostra bruto (envelope), não um plano amostral de M-06.

## 5. Ratificação em Q-020 (checklist)

- [ ] Baseline M-06 executado (workload congelado, seed determinístico, N declarado).
- [ ] Tolerância de IA recalculada sobre a taxa observada no baseline e registrada aqui.
- [ ] Tolerância de `server_fault` revisada (zero ou valor justificado).
- [ ] Export de `app.financial.states` definido (fonte, cadência, retenção).
- [ ] `--min-requests` alinhado ao N do baseline e ao custo de falso negativo.
- [ ] Carimbo Q-020; somente então remover o selo DRAFT deste documento e do script.

## 6. Referências

- `docs/runbooks/slo-error-budget.md` — apuração e escalonamento.
- `docs/specs/M-06/definition-of-done.md` — rótulos (`DRAFT`, `NOT-EXECUTED`, `UNKNOWN`).
- `docs/adr/ADR-022-error-taxonomy-observability.md` — taxonomia e política de retry.
- Plano Mestre §30/§31 — tolerâncias e degradação graciosa.
