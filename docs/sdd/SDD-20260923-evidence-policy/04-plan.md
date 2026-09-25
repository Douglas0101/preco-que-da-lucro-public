# 04 — Plano · SDD-20260923-evidence-policy

| ID          | Tarefa                                    | Ação                                                                            | Conclusão                                        | Risco                                                  | Depende de |
| ----------- | ----------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------ | ---------- |
| **TASK-01** | Declarar a política no manifesto          | adicionar bloco `evidence` ao gerador (node embutido no script)                 | campos presentes com valores medidos             | manifesto mentir sobre contagem (`RISK-01`)            | —          |
| **TASK-02** | Contar arquivos por classe                | no próprio gerador: total, versionáveis e ignorados                             | contagens exatas                                 | `RISK-01`                                              | TASK-01    |
| **TASK-03** | Gerar `evidence.git.sha256`               | `git ls-files -z --cached --others --exclude-standard -- <dir>` + `sha256sum`   | arquivo existe, sem `.log`, com os 5 de metadata | selo vazio se o comando mudar de semântica (`RISK-02`) | TASK-02    |
| **TASK-04** | Implementar `evidence-policy-check`       | etapa nova: compara declaração × `git check-ignore`, igualdade de contagem      | etapa em `steps.tsv`                             | verificador que nunca reprova (`RISK-03`)              | TASK-03    |
| **TASK-05** | **Controle negativo**                     | fixture com `gitTrackedLogs=true` e logs ignorados ⇒ espera-se reprovação       | exit ≠ 0 capturado                               | pular este passo torna TASK-04 vácuo                   | TASK-04    |
| **TASK-06** | Declarar bundle/patches como `local-only` | campo `artifacts.bundlePolicy`                                                  | campo presente                                   | —                                                      | TASK-01    |
| **TASK-07** | Reexecutar o pipeline                     | `./scripts/local-ci.sh`                                                         | `veredicto=success`                              | tempo (~6 min)                                         | TASK-05    |
| **TASK-08** | Commitar **apenas** metadata              | `git add` do script + `REPORT.md`/`manifest.json`/`*.tsv`/`evidence.git.sha256` | nenhum `*.log`, bundle ou patch no commit        | commitar log por engano (`RISK-04`)                    | TASK-07    |
| **TASK-09** | Verificar em clone limpo                  | `git clone` local do repo para `/tmp` e conferir presença dos arquivos citados  | citados existem no clone                         | citar arquivo não versionado (`RISK-05`)               | TASK-08    |

## Ordem e dependência

TASK-01…TASK-06 são **uma** mudança coesa em `scripts/local-ci.sh` (um commit). TASK-07 é a validação.
TASK-08 é o commit de evidência. TASK-09 é a verificação independente que fecha o ciclo — é ela que
prova que o manifesto commitado **não** aponta para arquivo ausente, que é o problema original.

## Timebox

- TASK-01…TASK-06: minutos.
- TASK-07: ~6 min.
- TASK-08…TASK-09: minutos.
