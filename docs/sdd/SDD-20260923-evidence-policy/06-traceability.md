# 06 — Rastreabilidade · SDD-20260923-evidence-policy

| REQ                                   | TASK             | TEST / AC    | EV           | Artefato                                  |
| ------------------------------------- | ---------------- | ------------ | ------------ | ----------------------------------------- |
| REQ-01 (manifesto declara a política) | TASK-01, TASK-02 | AC-01, AC-06 | EV-06        | `manifest.json` → `evidence.*`            |
| REQ-02 (selo só do versionável)       | TASK-03          | AC-02, AC-03 | EV-07        | `evidence.git.sha256`                     |
| REQ-03 (verificação fail-closed)      | TASK-04, TASK-05 | AC-04, AC-05 | EV-08        | `evidence-policy-check.log` + `steps.tsv` |
| REQ-04 (logs não desaparecem)         | TASK-02, TASK-07 | AC-06, AC-09 | EV-06, EV-09 | contagens no manifesto + selo integral    |
| REQ-05 (bundle/patches `local-only`)  | TASK-06          | AC-08        | EV-06        | `manifest.artifacts.bundlePolicy`         |
| REQ-06 (`.gitignore` intocado)        | TASK-08          | AC-07        | EV-10        | `git diff --stat` sem `.gitignore`        |

## Cobertura

- Requisitos: **6**. Com tarefa + teste + evidência: **6**. Lacunas: **nenhuma**.
- Fail-closed: requisito sem linha aqui é lacuna declarada, não omissão silenciosa.

## Identidade, não cardinalidade

Rastreio por identificador (`REQ-01…06`, `AC-01…09`, `EV-06…10`, `TASK-01…09`). Acrescentar requisito sem
acrescentar a linha correspondente reprova a revisão deste documento.

## Encadeamento com o journal

- Intenção: `PROGRESS.md` `L159` (`▶`) — a política é declarada na intenção.
- Resultado: `PROGRESS.md` `L160` (`✔`) — com a contagem real (versionáveis × ignorados).
