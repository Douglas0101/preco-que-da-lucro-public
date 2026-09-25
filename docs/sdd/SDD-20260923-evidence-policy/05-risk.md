# 05 — Riscos · SDD-20260923-evidence-policy

| ID          | Risco                                                                          | Prob. | Impacto                                                                          | Mitigação                                                                                                                | Sinal                                |
| ----------- | ------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| **RISK-01** | Manifesto informar contagem **estimada** em vez de medida                      | média | o manifesto mente — classe de falha que este repo persegue desde o WP-R6         | contagem derivada de `git ls-files`/`git check-ignore` no mesmo instante da escrita; `AC-06` compara com o mundo         | contagem declarada ≠ `find \| wc -l` |
| **RISK-02** | `evidence.git.sha256` sair vazio (semântica de `git ls-files` mal usada)       | média | selo que não cobre nada e passa desapercebido                                    | `AC-03` exige presença dos 5 arquivos de metadata; `--others --exclude-standard` é o que inclui untracked-não-ignorado   | `evidence.git.sha256` com 0 linhas   |
| **RISK-03** | `evidence-policy-check` nunca reprovar (verificador decorativo)                | média | falsa segurança: a política deixa de ser verificada de fato                      | **controle negativo obrigatório** (`AC-05`), com fixture e exit ≠ 0 capturado                                            | controle negativo retornando 0       |
| **RISK-04** | Commitar `*.log`, bundle ou patches por engano                                 | média | evidencia crua não revisada entra no repositório; contradiz a política declarada | `git status` inspecionado antes do commit; conferência de que nenhum `.log` está na lista do `git add`                   | `git show --stat` listando `.log`    |
| **RISK-05** | O commit de evidência citar arquivo ausente (o problema original, reencarnado) | média | auditoria futura vê manifesto apontando para o vazio                             | TASK-09 valida em **clone limpo**                                                                                        | clone sem o arquivo citado           |
| **RISK-06** | A política virar desculpa para não preservar log                               | baixa | perda de auditabilidade                                                          | logs permanecem **locais** e cobertos pelo selo integral; `localLogsAvailable=true` é declarado e a contagem é publicada | logs apagados do diretório           |
| **RISK-07** | Mudar `.gitignore` "sem querer" ao mexer em política                           | baixa | altera contrato do repositório sem aprovação                                     | REQ-06 + `AC-07` (diff vazio em `.gitignore`)                                                                            | `.gitignore` no diff                 |

## Risco aceito conscientemente

**RISK-08 — o repositório continua sem os logs.** Aceito: a política `metadata-only` é a recomendada pelo
enunciado e a alternativa (`full-logs`) exige aprovação humana e revisão de segredos. O manifesto
**declara** a limitação (`gitTrackedLogs=false`, `localLogsAvailable=true`) em vez de escondê-la.

## Não-riscos (verificados)

- **Runtime:** `local-ci.sh` não é executado pela aplicação; nenhum artefato de produção muda.
- **CI remoto:** enquanto não houver push, nenhum run dispara.
- **Banco:** nenhuma conexão nova; o tier de banco segue por escopo.
