# 06 — Rastreabilidade · SDD-20260923-ledger-state-marker

Cadeia: **requisito → tarefa → teste → evidência**.

| REQ                                            | TASK                      | TEST / AC    | EV           | Artefato                                  |
| ---------------------------------------------- | ------------------------- | ------------ | ------------ | ----------------------------------------- |
| REQ-01 (marcador aponta para o parent do HEAD) | TASK-02, TASK-03, TASK-08 | AC-01, AC-06 | EV-01, EV-03 | `EXECUTION-STATE-PROGRAM.md` (bloco novo) |
| REQ-02 (correção aditiva)                      | TASK-03                   | AC-03        | EV-02        | `git diff --numstat` do commit            |
| REQ-03 (âncoras resolvem)                      | TASK-05                   | AC-04        | EV-01        | `m02:temporal-guard` log                  |
| REQ-04 (journal `▶` antes / `✔` depois)        | TASK-01, TASK-09          | AC-08        | EV-04        | `PROGRESS.md` linhas `L159`/`L160`        |
| REQ-05 (sem push / sem mutação remota)         | TASK-06, TASK-08          | AC-07        | EV-05        | `git rev-parse origin/develop`            |

## Cobertura

- Requisitos: **5**. Cobertos por ao menos uma tarefa, um teste e uma evidência: **5**.
- Lacunas: **nenhuma**.
- A relação é **fail-closed**: um requisito sem linha nesta tabela é lacuna, não omissão tolerada.

## Identidade, não cardinalidade

A rastreabilidade é por **identificador** (REQ-01 … REQ-05, AC-01 … AC-08, EV-01 … EV-05), nunca por
contagem de linhas. Acrescentar um requisito sem acrescentar a linha correspondente **reprova** a
revisão deste documento.

## Encadeamento com o journal

- Intenção: `PROGRESS.md` `L159` (`▶`) — gravada **antes** da mutação.
- Resultado: `PROGRESS.md` `L160` (`✔`) — gravada **depois**, com o SHA novo e o ponteiro da evidência.
