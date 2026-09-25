# 02 — Critérios de aceite · SDD-20260923-evidence-policy

| ID        | Critério                                                | Comando                                                                          | Esperado                                                                  | Medido               |
| --------- | ------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------- |
| **AC-01** | Política declarada no manifesto                         | `node -e "…manifest.evidence…"`                                                  | `policy=metadata-only`, `gitTrackedLogs=false`, `localLogsAvailable=true` | ver `07-evidence.md` |
| **AC-02** | Selo versionável gerado e sem logs                      | `grep -c '\.log$' evidence.git.sha256`                                           | `0`                                                                       | ver `07-evidence.md` |
| **AC-03** | Selo versionável cobre o metadata esperado              | `grep -cE '(manifest\.json                                                       | REPORT\.md                                                                | steps\.tsv           | adaptations\.tsv | pendencies\.tsv)$'` | `5` | ver `07-evidence.md` |
| **AC-04** | Etapa de verificação existe e passa                     | `steps.tsv` contém `evidence-policy-check` = `success`                           | presente e `success`                                                      | ver `07-evidence.md` |
| **AC-05** | **Controle negativo** — a etapa reprova sob contradição | fixture: manifesto declarando `gitTrackedLogs=true` com logs ignorados presentes | exit ≠ 0 (`failure`)                                                      | ver `07-evidence.md` |
| **AC-06** | Contagens do manifesto conferem com o mundo             | `filesTotal` = nº real de arquivos; `filesGitIgnored` = nº real ignorado         | igualdade exata                                                           | ver `07-evidence.md` |
| **AC-07** | Nenhuma mudança de `.gitignore`                         | `git diff --stat <commit>^ <commit> -- .gitignore`                               | vazio                                                                     | ver `07-evidence.md` |
| **AC-08** | Bundle e patches declarados como não versionados        | `manifest.artifacts.bundlePolicy`                                                | `local-only`                                                              | ver `07-evidence.md` |
| **AC-09** | Selo integral preservado                                | `sha256sum -c <sha>.sha256`                                                      | todas as linhas OK                                                        | ver `07-evidence.md` |

## Regra anti-vacuidade

- **AC-05 é obrigatório e é o mais importante deste SDD.** Um verificador de política que nunca reprova
  não é verificador — é decoração. O controle negativo é executado contra uma fixture, com o resultado
  capturado, e a etapa é **falsificável por construção**.
- **AC-06 é igualdade de contagem, não "mais ou menos".** É a mesma disciplina do
  `checked === discovered` que o repo adota nos selos; enumerar por lista conhecida deixa buraco
  silencioso quando um arquivo novo aparece.
- **AC-02 e AC-03 são conjuntivos:** um selo vazio passaria em `AC-02` (zero logs) sem cobrir nada, por
  isso `AC-03` exige presença dos cinco arquivos de metadata.
