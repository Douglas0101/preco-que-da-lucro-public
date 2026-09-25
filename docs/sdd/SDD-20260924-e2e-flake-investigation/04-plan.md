# 04 — Plano · SDD-20260924-e2e-flake-investigation

**Nada deste plano foi executado.** Ele existe para que a investigação comece com método, não com
tentativa e erro. Cada tarefa tem uma precondição de aprovação.

| #           | Tarefa                                                                                     | Depende de       | Entrega                                                           | Aprovação |
| ----------- | ------------------------------------------------------------------------------------------ | ---------------- | ----------------------------------------------------------------- | --------- |
| **TASK-01** | Reproduzir o cenário em ambiente controlado (carga de memória, e2e + tier de banco)        | aprovação humana | taxa de falha sob carga, ou "não reproduzido em N"                | humana    |
| **TASK-02** | Coletar métricas de recursos durante a execução (REQ-05)                                   | TASK-01          | série de memória/carga × resultado                                | humana    |
| **TASK-03** | Medir latência do redirect de login e do webServer, sem alterar timeout                    | —                | distribuição de latência por execução                             | humana    |
| **TASK-04** | Provar que o diagnóstico funciona (AC-06, controle negativo)                               | —                | falha injetada ⇒ 5 artefatos presentes                            | humana    |
| **TASK-05** | Analisar correlações **com N suficiente** e nomear o mecanismo, ou declarar indeterminação | TASK-01..03      | relatório de causa (ou de indeterminação com hipóteses refutadas) | humana    |
| **TASK-06** | Propor solução **com mecanismo nomeado**                                                   | TASK-05          | proposta + taxa antes/depois                                      | humana    |
| **TASK-07** | Criar **ADR** se a solução alterar contrato (retry, timeout, config do Playwright)         | TASK-06          | ADR em `docs/adr/`                                                | humana    |
| **TASK-08** | Validar em 3 execuções consecutivas                                                        | TASK-06/07       | 3 rodadas verdes + comparação de taxas                            | humana    |

## Ordem obrigatória

**TASK-04 antes de TASK-01.** Se o diagnóstico não funciona, uma falha reproduzida em TASK-01 chega
**sem evidência** — e a investigação recomeça. É o mesmo princípio dos casos negativos antes do
encadeamento no ciclo anterior: a capacidade de **detectar** precede a de **investigar**.

## Declaração de esforço

- TASK-01..04: uma sessão (carga controlada + instrumentação de leitura).
- TASK-05..08: dependem do que TASK-01..04 encontrarem. **Não há estimativa honesta** para uma
  investigação cujo resultado pode ser "indeterminado" — e estimar um número aqui seria inventá-lo.

## Critério de parada

A investigação **para** e declara indeterminação quando: (a) TASK-01 não reproduzir a falha em N
execuções com carga declarada, **e** (b) TASK-03/04 mostrarem que a próxima ocorrência chegará com
diagnóstico completo. Nesse ponto, "monitorar com detector" é o estado final legítimo — não uma
desistência.
