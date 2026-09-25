# 05 — Riscos · SDD-20260924-e2e-flake-investigation

| ID          | Risco                                                                   | Prob.    | Impacto                                                                                                                     | Mitigação                                                                                                   | Sinal de que ocorreu                                    |
| ----------- | ----------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **RISK-01** | Retry mascara falha real                                                | média    | perda de sinal num gate — o pior resultado, porque fica invisível                                                           | retry **proibido sem ADR**; se aprovado, publicar taxa antes/depois                                         | veredicto verde com taxa de falha inalterada            |
| **RISK-02** | Isolamento não reproduz o problema                                      | **alta** | esforço gasto sem correção                                                                                                  | já há evidência: `db:test` antes do e2e deu **30/30**; isolamento entra como **higiene**, não como correção | 3 verdes com o isolamento e a falha reaparecendo depois |
| **RISK-03** | Investigação não encontra causa raiz                                    | **alta** | custo sem resposta                                                                                                          | declarar **indeterminada com evidência** (hipóteses testadas e refutadas) + entregar o **detector**         | TASK-01 não reproduz em N execuções                     |
| **RISK-04** | A solução introduz novo flake                                           | média    | troca um flake por outro                                                                                                    | validar em 3 execuções + comparar taxas                                                                     | nova falha em teste diferente                           |
| **RISK-05** | O diagnóstico altera o timing e **esconde** a falha (efeito observador) | média    | a investigação destrói o fenômeno que estuda                                                                                | instrumentar **sem** mudar timeout/asserção; comparar taxa antes/depois da instrumentação                   | taxa cai após instrumentar, sem correção                |
| **RISK-06** | Conclusão a partir de **n=1**                                           | **alta** | perseguir mecanismo inexistente — **já aconteceu**: a correlação "só com `db:test`" foi refutada por experimento controlado | ler taxa como **série**; exigir N declarado antes de concluir                                               | conclusão publicada com N < 5                           |
| **RISK-07** | Aumento de timeout destrói a série sem corrigir                         | média    | falha fica rara e o dado some                                                                                               | timeout só muda com mecanismo nomeado (REQ-06)                                                              | timeout alterado sem causa publicada                    |

## Risco aceito conscientemente

**RISK-08 — manter `retries: 0` e conviver com o transiente.** É a decisão **vigente**
(`E2E_FLAKE_DECISION=known-limitation`). O custo é conhecido: ~6 min por re-execução quando ocorre, a
~1 em 30. A alternativa (retry) tem custo **maior e invisível**. O que mudou no Item 5 é a
**capacidade de diagnosticar** — a próxima ocorrência chega com trace, screenshot, vídeo e
error-context.

## Não-riscos (verificados)

- **Nada foi implementado:** este SDD é spec-only; nenhum arquivo de configuração, teste ou workflow foi
  tocado.
- **Nenhuma dependência nova**, nenhuma mutação remota, nenhum contrato de gate alterado.
- **A hipótese de memória está declarada como hipótese**, não como causa — o OOM da máquina é
  **compatível** com a falha, o que não é o mesmo que **explicá-la**.
