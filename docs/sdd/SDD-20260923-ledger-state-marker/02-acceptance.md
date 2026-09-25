# 02 — Critérios de aceite · SDD-20260923-ledger-state-marker

Cada critério tem comando, valor esperado e o resultado medido. **Nada é declarado sem comando.**

| ID        | Critério                                                        | Comando                                                               | Esperado                                                  | Medido                                                                         |
| --------- | --------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **AC-01** | `m02:state:check` verde no novo HEAD                            | `npm run m02:state:check`                                             | exit 0 + `state marker is valid for HEAD`                 | ver `07-evidence.md`                                                           |
| **AC-02** | `m02:state:check` estava vermelho **antes** (controle negativo) | `git stash`-free: medido em `8683c2d` antes da correção               | exit 1 + `Ledger M-02 desatualizado`                      | exit 1 (medido na sessão anterior e reproduzido no `local-ci` da rodada 1 e 2) |
| **AC-03** | correção é aditiva (nenhuma linha histórica removida)           | `git diff --numstat <commit>^ <commit> -- EXECUTION-STATE-PROGRAM.md` | apenas inserções (`0` deleções)                           | ver `07-evidence.md`                                                           |
| **AC-04** | âncoras do bloco novo resolvem no git                           | `npm run m02:temporal-guard`                                          | exit 0                                                    | ver `07-evidence.md`                                                           |
| **AC-05** | formatação preservada                                           | `npm run format:check`                                                | exit 0                                                    | ver `07-evidence.md`                                                           |
| **AC-06** | pipeline local completo verde no novo HEAD                      | `./scripts/local-ci.sh`                                               | `veredicto=success` e etapa `m02:state:check` = `success` | ver `07-evidence.md`                                                           |
| **AC-07** | nenhum push                                                     | `git rev-parse origin/develop`                                        | inalterado (`a2f5ff6…`)                                   | inalterado                                                                     |
| **AC-08** | journal registra intenção **antes** e resultado **depois**      | linhas `L159` (`▶`) e `L160` (`✔`) em `PROGRESS.md`                   | `L159` descreve a mutação e precede a edição              | ver `07-evidence.md`                                                           |

## Regra anti-vacuidade

- **AC-02 é o controle negativo obrigatório:** sem ele, "verde depois" não distingue _correção_ de
  _check que nunca reprova_. O vermelho de abertura está capturado no log da etapa `m02:state:check`
  das duas rodadas anteriores do `local-ci` (`docs/evidence/local-ci/8683c2d…/m02:state:check.log`).
- **AC-06 exige a etapa pelo nome.** Um `success` global sem a etapa nomeada em `steps.tsv` não satisfaz.
- **AC-03 impede a porta de trás:** corrigir por edição in-place da linha histórica teria o mesmo efeito
  observável de `AC-01`; o `--numstat` é o que separa adição de reescrita.
