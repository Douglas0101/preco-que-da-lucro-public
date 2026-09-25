# Brief de decisão Q-024 — ratificação do SDD v5.1-EXEC

Data: 2026-08-27
Status: `⛔ DECISION` — não aplicado por este brief
Escopo: tornar o SDD v5.1-EXEC a fonte autoritativa do programa para protocolos, runbooks e classes de evidência.

## Contexto

O SDD v5.1-EXEC consolida o baseline do checkout, as classes epistêmicas, o
backlog P0–P11, o protocolo de subagents, os runbooks de partição/scan e a
máquina de estados proposta para M-04. Ele mantém explicitamente Q-021, Q-022,
Q-023, Q-019, Q-020, Q-017 e Q-001/A1 como decisões ou gates separados.

O checkout local observado antes desta rodada está na branch
`program/v5-fechamento-sdd`, em `154efcd94c97d77d7061ac557e6d6cbf17472395`, com
worktree deliberadamente dirty. Essa observação é `LOCAL-VERIFIED`; o conteúdo
do documento SDD fornecido nesta rodada é tratado como instrução operacional
do usuário, mas a autoridade documental completa continua pendente de Q-024.

## Opções

| Opção                                        | Benefício                                                                          | Custo/risco                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Ratificar Q-024                              | Uma única fonte operacional; reduz deriva entre conversa, ledger, specs e runbooks | O documento passa a exigir controle formal de adendos e qualquer conflito futuro precisa ser registrado na mesma rodada |
| Não ratificar ainda                          | Mantém liberdade para revisar a consolidação                                       | Mantém risco de executar protocolo divergente e não dá autoridade ao backlog P0–P11                                     |
| Ratificar somente como protocolo operacional | Permite P0–P8, sem declarar autoridade documental total                            | Cria uma distinção temporária adicional entre execução e documentação                                                   |

## Recomendação

Recomenda-se **aprovar Q-024** no escopo exato “SDD v5.1-EXEC como fonte
operacional e documental autoritativa, sujeito aos gates humanos internos e aos
adendos datados do §12”. A recomendação não autoriza push, merge, freeze,
migração, produção ou consumo dos demais Q-gates.

## Rollback

Antes de qualquer publicação, revogar a ratificação removendo a referência de
autoridade do ledger e marcando este brief como superseded por um adendo datado;
preservar o SDD original e os artefatos de execução para auditoria. Nenhum
histórico Git publicado precisa ser reescrito.

## Evidência anexada

- `EXECUTION-STATE-PROGRAM.md` — estado local e histórico, `LOCAL-VERIFIED` no
  checkout corrente;
- `docs/specs/M-02/`, `docs/specs/M-04/` e `docs/specs/M-06/` — specs ainda
  `DRAFT`;
- `docs/evidence/e6-determinism-2026-08-27.md` — E6 local 12/12;
- SDD v5.1-EXEC fornecido pelo humano nesta rodada — instrução de trabalho,
  não evidência independente.
