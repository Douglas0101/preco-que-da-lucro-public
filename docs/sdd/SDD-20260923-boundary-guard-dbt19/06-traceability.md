# 06 — Rastreabilidade · SDD-20260923-boundary-guard-dbt19

| REQ                                                        | TASK       | TEST / AC    | Evidência            | Artefato                                                |
| ---------------------------------------------------------- | ---------- | ------------ | -------------------- | ------------------------------------------------------- |
| REQ-01 (guarda fail-closed)                                | T3, T5     | AC-01, AC-02 | EV-D19-01, EV-D19-02 | `matrix.yaml` mutado + saída do guard                   |
| REQ-02 (closure test)                                      | T1, T11    | AC-04        | EV-D19-03            | teste versionado + nota ao MAESTRO                      |
| REQ-03 (casos negativos)                                   | T2, T3, T4 | AC-01, AC-02 | EV-D19-01, EV-D19-02 | `auditSecrets` fixture + captura RED                    |
| REQ-04 (medição de custo)                                  | T0, T9     | AC-05, AC-06 | EV-D19-04            | tabela de 3 execuções por guarda                        |
| REQ-05 (integração ao `check`, ou alternativa justificada) | T7, T8     | AC-03        | EV-D19-05            | `package.json` + `ui-stack.yml` + tabela do `AGENTS.md` |
| REQ-06 (compatível com `metadata-only`)                    | T1         | AC-10        | EV-D19-06            | execução com `docs/evidence/local-ci/**` presente       |
| REQ-07 (compatível com `_archive/`)                        | T1         | AC-10        | EV-D19-06            | idem (o `_archive` está presente na árvore medida)      |
| REQ-08 (nenhum acesso remoto)                              | T0         | AC-07, AC-08 | EV-D19-04            | inspeção de imports + execução offline                  |
| REQ-09 (nenhum billing)                                    | —          | AC-07        | EV-D19-07            | nenhuma chamada; declarado no journal                   |
| REQ-10 (nenhum segredo exposto)                            | T2         | AC-09        | EV-D19-08            | saída `{path, reason}` revisada                         |

## Cobertura

- Requisitos: **10**. Com tarefa, teste e evidência: **10**. Lacunas: **nenhuma declarada**.
- **Fail-closed:** requisito sem linha nesta tabela é lacuna, não omissão tolerada.

## Identidade, não cardinalidade

Rastreio por identificador (`REQ-01…10`, `AC-01…10`, `T0…T11`, `EV-D19-01…08`). Acrescentar requisito sem
acrescentar a linha correspondente reprova a revisão deste documento. Os 10 `REQ` e os 10 `AC` são
exatamente os declarados na SPEC e no `02-acceptance.md` — `checked === discovered`.

## Encadeamento com o journal e com o ADR

- **ADR:** `docs/adr/ADR-030-boundary-guard-dbt19.md` (estado **PROPOSTA** — implementação não iniciada).
- **Intenção:** `PROGRESS.md` `L161` (`▶`) — item 6 declarado como _preparação_, não implementação.
- **Resultado:** `PROGRESS.md` `L163` (`✔`).
- **Registry:** o fechamento de `DBT-19` exige escrita do **MAESTRO**; a nota de fechamento é T11.

## Evidência deste ciclo (o que já existe, medido)

| EV              | Conteúdo                                                                               | Onde                                                                     |
| --------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| EV-D19-04       | custo: 240/204/197 ms e 1781/1802/1828 ms; imports só `node:fs`/`node:path`/`node:url` | `ADR-030` §1.3 e §1.4                                                    |
| EV-D19-05       | a cadeia `check` tem 14 membros e a heavy roda 12 deles como passos diretos            | `package.json` + `ui-stack.yml`                                          |
| EV-D19-06       | ambas passam com `docs/evidence/local-ci/**` e `_archive/` presentes                   | execuções desta rodada (3/3 cada)                                        |
| EV-D19-07       | nenhuma chamada de billing; nenhum push                                                | `manifest.json` → `security.billingChanges=false`, `pushPerformed=false` |
| EV-D19-08       | saída do audit é `{path, reason}`                                                      | `scripts/m02-secrets-audit.ts` (leitura)                                 |
| EV-D19-01/02/03 | **ainda não existem** — dependem de T1–T4 (bloqueados por aprovação)                   | —                                                                        |
