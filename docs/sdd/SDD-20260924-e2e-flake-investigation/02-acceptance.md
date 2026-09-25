# 02 — Critérios de aceite · SDD-20260924-e2e-flake-investigation

| #         | Critério                                                                  | Como é medido                                                                                                                                                  | Estado       |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| **AC-01** | Causa raiz **identificada**, ou **declarada indeterminada com evidência** | relatório com o experimento que isola o mecanismo, ou com o conjunto de hipóteses testadas e refutadas                                                         | **PENDENTE** |
| **AC-02** | A solução proposta **não mascara** falha real                             | a taxa de falha **antes** e **depois** é medida e publicada; nenhum timeout/retry muda sem mecanismo nomeado                                                   | **PENDENTE** |
| **AC-03** | Nenhuma alteração de contrato sem **ADR**                                 | `git diff` em `playwright.config.ts`, `package.json`, workflows e `local-ci.sh` — qualquer mudança exige ADR aprovada                                          | **PENDENTE** |
| **AC-04** | **Teste de regressão reproduz o cenário de falha**                        | um caso que falha hoje pelo mesmo mecanismo e passa depois da correção — ou, se a causa for indeterminada, um caso que **detecta e diagnostica** a recorrência | **PENDENTE** |
| **AC-05** | Solução validada em **3 execuções consecutivas**                          | 3 rodadas completas do tier de e2e, verdes, com o mesmo SHA                                                                                                    | **PENDENTE** |
| **AC-06** | O diagnóstico de falha foi **exercitado** (controle negativo de REQ-04)   | falha artificial injetada ⇒ artefatos presentes e nomeados                                                                                                     | **PENDENTE** |
| **AC-07** | `retries` continua **0**, ou a mudança tem ADR                            | `grep retries playwright.config.ts` + existência de ADR                                                                                                        | **PENDENTE** |
| **AC-08** | A taxa de falha é lida como **série**, não como ponto                     | journal com N execuções e a contagem, sem conclusão a partir de 1 ocorrência                                                                                   | **PENDENTE** |

## Regra anti-vacuidade

- **AC-01 aceita "indeterminada"** — mas só com a lista de hipóteses **testadas e refutadas**. Declarar
  indeterminação sem ter testado nada é `NS`, não `AC-01`.
- **AC-02 é conjuntivo com AC-05:** 3 verdes não provam nada se a taxa anterior era 1 em 30. O que
  valida é a **comparação** de taxas com o mecanismo nomeado.
- **AC-04 não aceita "não conseguimos reproduzir"** como cumprimento: nesse caso o entregável é um
  **detector** que capture a próxima ocorrência com evidência suficiente para diagnosticá-la.
- **AC-06 é o controle negativo do instrumento de diagnóstico** — sem ele, o diagnóstico de REQ-01 é
  uma promessa não exercitada.
