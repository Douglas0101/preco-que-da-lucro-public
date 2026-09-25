# 07 — Evidência · SDD-20260923-ledger-state-marker

Todas as medições foram feitas nesta máquina, no repositório
`/home/douglas-souza/preco-que-d-main`, branch `develop`.

| EV        | O que prova                                              | Comando                                           | Saída (verbatim, resumida)                                                                                                                                                  |
| --------- | -------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **EV-01** | `m02:state:check` **vermelho antes** (controle negativo) | `npm run m02:state:check` em `8683c2d`            | `Ledger M-02 desatualizado: registre HEAD 8683c2dbe46a98eb98be7a734cbc951e00cfa6b5 ou o parent-pinned marker 2edb55b6ac11284a86075dff20a8f5e387563cfd antes de prosseguir.` |
| **EV-02** | `m02:state:check` **verde depois**                       | `npm run m02:state:check` em `3c088b6`            | `M-02 latest parent-pinned state marker is valid for HEAD 3c088b671c6c4825eaa251dcc24743802b329048 on develop.`                                                             |
| **EV-03** | correção é **aditiva** (AC-03)                           | `git diff --cached --numstat` do commit `3c088b6` | `EXECUTION-STATE-PROGRAM.md  +29  -0`                                                                                                                                       |
| **EV-04** | o green sobrevive ao commit seguinte                     | `npm run m02:state:check` em `86565f0`            | `M-02 latest parent-pinned state marker is valid for HEAD 86565f017d6e7f58ae864a9b5fc46ec5b01a90aa`                                                                         |
| **EV-05** | a etapa aparece **verde no pipeline**, não só à mão      | `steps.tsv` da evidência de `3c088b6`             | `m02:state:check  success  0s` (era `failure` nas rodadas de `8683c2d`)                                                                                                     |
| **EV-06** | âncoras resolvem e a prosa viva continua válida          | `npm run m02:temporal-guard`                      | exit 0 (executado antes do commit e novamente no `local-ci`)                                                                                                                |
| **EV-07** | journal com intenção **antes** e resultado **depois**    | `PROGRESS.md`                                     | linhas `L159` (`▶`, 03:11:24) e `L160` (`✔`)                                                                                                                                |
| **EV-08** | nenhum push / nenhuma mutação remota                     | `git rev-parse origin/develop` \| `origin/main`   | `a2f5ff67e58ccff9035a972eff4ef171912036ca` \| `9724d2c73b269d0a0199ea305308f3237b38fa09` (ambos como antes do ciclo)                                                        |

## Evidência persistida (caminhos)

- `docs/evidence/local-ci/3c088b671c6c4825eaa251dcc24743802b329048/` — pipeline completo no HEAD corrigido (`verdict=success`, 311 s), com a etapa `m02:state:check` em `success`.
- `docs/evidence/local-ci/8683c2dbe46a98eb98be7a734cbc951e00cfa6b5/` — rodada anterior, onde a mesma etapa é `failure` (preserva o vermelho de origem; **não** versionada, decisão declarada).
- `EXECUTION-STATE-PROGRAM.md` — bloco `### Ciclo SDD-20260923` e o marcador vivo.

## Lacuna declarada

**EV-09 — o vermelho de origem não está em nenhum arquivo versionado.** O `m02:state:check.log` que
contém o `failure` pertence à evidência de `8683c2d`, que ficou **local** por decisão de política (o
layout dela antecede a política `metadata-only` e o `preservation/` dela não é ignorado pelo Git). O
vermelho está reproduzido **verbatim** em EV-01 e nos logs locais; quem clonar o repositório vê o
verde, não o par antes/depois. Registrado como pendência de versionamento em `docs/TODO.md`.

## Não-evidências (o que NÃO foi medido)

- **Não** houve execução no CI remoto: a cota de plataforma segue bloqueando jobs (0 passos). Nenhum
  `run@sha` é citado por este SDD — citar run inexistente é proibido pelo protocolo de bloqueio.
- **Não** houve verificação de que o marcador se mantém verde em commits futuros que não o atualizem:
  a disciplina continua manual (é o `RISK-08` do `05-risk.md`).
