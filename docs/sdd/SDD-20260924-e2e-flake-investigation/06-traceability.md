# 06 — Rastreabilidade · SDD-20260924-e2e-flake-investigation

## Requisito → critério de aceite → tarefa

| REQ                                                           | AC correspondente | Tarefa que entrega                     | Estado   |
| ------------------------------------------------------------- | ----------------- | -------------------------------------- | -------- |
| **REQ-01** captura automática na próxima ocorrência           | AC-04, AC-06      | TASK-04 (provar) + desenho do detector | PENDENTE |
| **REQ-02** instrumentação de latência sem mudar comportamento | AC-02, AC-08      | TASK-03                                | PENDENTE |
| **REQ-03** série, não ponto                                   | AC-08             | TASK-01, TASK-05                       | PENDENTE |
| **REQ-04** controle negativo do diagnóstico                   | AC-06             | TASK-04                                | PENDENTE |
| **REQ-05** hipótese de memória testável                       | AC-01             | TASK-02, TASK-05                       | PENDENTE |
| **REQ-06** nenhuma solução sem mecanismo                      | AC-02, AC-03      | TASK-05, TASK-06, TASK-07              | PENDENTE |

**`checked === discovered`:** 6 REQ declarados, **6** com AC e tarefa atribuída — nenhum REQ órfão, e
nenhuma tarefa sem REQ que a justifique (TASK-08 valida AC-05; TASK-07 cobre AC-03).

## Vínculo com o que já existe

| Insumo                      | Onde vive                                                 | O que fornece                                               |
| --------------------------- | --------------------------------------------------------- | ----------------------------------------------------------- |
| A ocorrência medida         | `docs/evidence/local-ci/c7e6a558…/playwright-e2e.log`     | o teste que falhou, o timeout, o `toHaveURL` não satisfeito |
| A refutação da correlação   | `docs/sdd/SDD-20260923-local-ci-hardening/07-evidence.md` | o experimento controlado (30/30 com `db:test` antes)        |
| A decisão vigente           | journal `L168` + `08-report.md` do Item 5                 | `known-limitation`, sem retry automático                    |
| O diagnóstico já preservado | `scripts/local-ci.sh` (frente E do Item 5)                | trace/screenshot/vídeo/error-context sob `artifacts/`       |
| A política de `retries`     | `playwright.config.ts` (`retries: 0`)                     | o motivo de um transiente reprovar a rodada                 |

## O que este SDD **não** cobre

- Flakiness de testes unitários (sem ocorrência registrada).
- O comportamento do e2e **no CI remoto** (bloqueado por cota; a série disponível é local).
- A decisão sobre `retries` — ela é **humana** e exige ADR se mudar.
