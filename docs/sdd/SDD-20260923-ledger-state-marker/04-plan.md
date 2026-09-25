# 04 — Plano · SDD-20260923-ledger-state-marker

Tarefas pequenas, com critério de conclusão e risco. Ordem executada.

| ID          | Tarefa                                                  | Ação / comando                                                                                        | Conclusão                                          | Risco                                                       | Depende de |
| ----------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| **TASK-01** | Registrar a intenção no journal                         | acrescentar a linha `L159` (`▶`) em `PROGRESS.md` **antes** de qualquer edição                        | linha existe e descreve a mutação                  | baixo                                                       | —          |
| **TASK-02** | Confirmar o parent-alvo                                 | `git rev-parse HEAD`                                                                                  | `8683c2dbe46a98eb98be7a734cbc951e00cfa6b5`         | SHA errado no marcador ⇒ check continua vermelho (`RUN-01`) | —          |
| **TASK-03** | Acrescentar bloco novo ao ledger                        | edição aditiva ao fim de `EXECUTION-STATE-PROGRAM.md` com `Latest state marker parent = \`8683c2d…\`` | bloco presente; nenhuma linha histórica alterada   | `RUN-02` (quebrar o guard temporal)                         | TASK-02    |
| **TASK-04** | Normalizar formatação                                   | `npx prettier --write EXECUTION-STATE-PROGRAM.md docs/TODO.md docs/sdd`                               | `format:check` verde                               | formatter reflui tabelas do journal                         | TASK-03    |
| **TASK-05** | Verificar guard temporal                                | `npm run m02:temporal-guard`                                                                          | exit 0                                             | `RUN-02`                                                    | TASK-04    |
| **TASK-06** | Commit A (correção + specs + TODO + script)             | `git add … && git commit`                                                                             | commit criado; `--numstat` só inserções            | `RUN-03` (marcador do próximo commit)                       | TASK-05    |
| **TASK-07** | Revalidar o novo HEAD                                   | `./scripts/local-ci.sh`                                                                               | `veredicto=success`, `m02:state:check` = `success` | tempo de execução (~6 min)                                  | TASK-06    |
| **TASK-08** | Commit B (metadata da evidência + marcador → HEAD de A) | `git add` do metadata + ledger + `git commit`                                                         | `m02:state:check` verde **no novo HEAD**           | `RUN-03`                                                    | TASK-07    |
| **TASK-09** | Fechar journal e relatório                              | linha `L160` (`✔`), `07-evidence.md`, `08-report.md`                                                  | registro completo                                  | —                                                           | TASK-08    |

## Regra de ordenação (não negociável)

**O marcador é parte do commit, não um passo posterior.** Consequência prática neste ciclo, com **dois**
commits:

- Commit **A** contém o marcador apontando para o parent de A (`8683c2d`) ⇒ check verde em A.
- Commit **B** contém o marcador apontando para o parent de B (= HEAD de A) ⇒ check verde em B.

Se B não atualizar o marcador, o check fica vermelho no tip — exatamente o defeito que este SDD corrige.
Cada commit do ciclo carrega a sua própria linha.

## Timebox

- TASK-01…TASK-06: minutos.
- TASK-07: ~6 min (medido: 359 s no `local-ci` anterior).
- TASK-08…TASK-09: minutos.
- **Sem** dependência de rede/plataforma em nenhuma tarefa.
