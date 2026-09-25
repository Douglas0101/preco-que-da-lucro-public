# 08 — Relatório · SDD-20260923-local-ci-hardening (Item 5)

## Veredicto

**`EXECUTADO` — hardening concluído, com 14/14 critérios de aceite medidos.** Nenhum contrato de gate foi
alterado; o que mudou foi a **confiabilidade do instrumento**.

## O que mudou

| Frente                 | Antes                                                  | Depois                                                                                                   |
| ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **A** ruído do scan    | 12 hits benignos por rodada; revisão manual a cada vez | allowlist **declarada** (5 entradas mínimas, todas usadas) + classificador **testável**; `hits=0`        |
| **B** contagens        | "as contagens valem em `measuredAt`" (prosa)           | declarado no manifesto + `filesIgnoredOther` + `treeState` + **cross-check** que **falha** se divergirem |
| **C** selo versionável | `manifest.sha256` fora (L2)                            | dentro — conjunto estabilizado antes da medição                                                          |
| **D** árvore suja      | recusa por exit 2                                      | recusa **+ escape registrado** no manifesto e como **pendência nominal**                                 |
| **E** e2e              | falha perdia o diagnóstico                             | trace/screenshot/vídeo/error-context preservados sob `artifacts/`; **sem retry**                         |
| **F** worktrees        | desconhecidas                                          | inventariadas (local); **nenhuma remoção**                                                               |

## A decisão que mais importou

O cross-check de contagens que eu tinha acabado de escrever **reprovou o meu próprio selo** na primeira
execução real (`cobre 91, declara 91`). Investigar mostrou que o **selo estava certo** e o número
**declarado** é que estava 1 abaixo — a imprecisão **L1**, que até então era apenas prosa no relatório.
Transformá-la em falha de gate foi o que a fez ser corrigida na raiz em vez de tolerada.

O mesmo padrão aparece nas quatro voltas do ciclo: **cada mecanismo novo encontrou um defeito real** —
inclusive quatro defeitos meus (padrão ERE inválido, literais no instrumento, escrita durante a rodada,
veredicto que não chegava ao exit code). Nenhum foi mascarado.

## Precisão de alvo (registrada porque mudou a implementação)

O despacho pediu "redução de ruído do **secret-audit**". Medição: o `m02:secrets-audit` tem **0**
literais na árvore e **não possui** padrão de URL postgres — os hits vêm do **`range-secret-scan` do
`local-ci`**. A allowlist foi aplicada no instrumento que produz o ruído. Aplicá-la no outro teria
alterado a guarda errada e deixado o ruído intacto.

## Custo

- 6 commits locais, nenhum push.
- Rodadas do pipeline: 4 (três falhas diagnosticadas + a verde de 341 s).
- Custo do scan no pipeline: desprezível (o `git grep` roda uma vez sobre os arquivos do range).

## Falha ambiental declarada

Uma rodada falhou em `format:check` sobre um arquivo comprovadamente limpo e **não foi reproduzida**. A
máquina entrou em **OOM e congelou**, exigindo reinício bruto. O mesmo commit passou depois. Registrado
como não reproduzido com causa provável — não como defeito e não como lenda.

## Reversão

`git revert` dos commits do ciclo. Tudo é aditivo ao instrumento; nenhum gate, workflow ou
`package.json` foi tocado. O comportamento anterior do scan volta com a allowlist removida.

## O que este ciclo **não** fez

- Não tocou `package.json`, `ui-stack.yml`, `ci-light.yml` ou `AGENTS.md`.
- Não adicionou retry ao e2e (exigiria ADR; decisão humana: `known-limitation`).
- Não removeu nenhuma worktree.
- Não escreveu em `DEBTS.md` nem em `QUEUE.md` (escritor é o MAESTRO).
