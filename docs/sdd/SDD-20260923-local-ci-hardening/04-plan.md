# 04 — Plano · SDD-20260923-local-ci-hardening

Ordem executada (a do despacho), com o que **de fato** aconteceu em cada passo.

| #   | Passo                                  | Resultado                                                                   |
| --- | -------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Spec/SDD atualizado                    | ✅ `01-spec` (REQ-01…REQ-09) + este conjunto                                |
| 2   | Casos negativos **antes** da allowlist | ✅ `src/test/local-ci-secret-scan.test.ts` — **12 casos** (N1–N12)          |
| 3   | Allowlist mínima implementada          | ✅ 5 entradas, **todas usadas**; 2 escritas por precaução foram **podadas** |
| 4   | `measuredAt` e contagens no manifesto  | ✅ + `filesIgnoredOther`, `countsAreSnapshotAt`, `treeState`                |
| 5   | `manifest.sha256` no selo versionável  | ✅ conjunto estabilizado antes da medição; cross-check de contagem          |
| 6   | Pré-condição de árvore suja endurecida | ✅ escape **registrado** no manifesto + **pendência nominal**               |
| 7   | Flakiness do e2e como limite conhecido | ✅ + preservação de trace/screenshot/error-context                          |
| 8   | Inventário de worktrees                | ✅ `_ops/artifacts/worktree-inventory.md` (local; **nenhuma remoção**)      |
| 9   | `local-ci` completo no novo HEAD       | ver `07-evidence.md`                                                        |
| 10  | Commit da evidência metadata-only      | ver `07-evidence.md`                                                        |
| 11  | Journal e TODO                         | ✅ `L167`/`L168`                                                            |

## Duas correções que o plano não previa — e por que foram necessárias

**1. O fail-open do padrão (POSIX ERE).** O primeiro padrão amplo usava `\b` e `(?:...)`; `git grep -E`
não suporta nenhum dos dois, o padrão casou **zero** linhas e o resumo saiu `total=0` —
**indistinguível de "limpo"**. Corrigido em dois níveis: ERE estrito **e** teste de vivacidade
obrigatório (5 probes; falha ⇒ precondição). Este passo **não estava no plano** e é o mais importante
do ciclo: sem ele, o Item 5 teria entregado um scanner silenciosamente cego.

**2. O instrumento carregava o que procura.** A primeira rodada **falhou** com `m02:secrets-audit`
reprovando: o probe de vivacidade tinha um `ghp_…` literal de 40 caracteres num script commitado. Três
classes, três correções (ver `03-design.md` §4 e `08-report.md`): probes em runtime, fixtures em
runtime, e isenção **por código** do arquivo que declara a allowlist — com N11 provando que a isenção
não é ponto cego.

## Regra de ordenação que se manteve

**Nenhuma supressão antes da prova de que a detecção continua.** Os 12 casos negativos existiam e
passavam **antes** de a allowlist ser ligada ao pipeline — e o caso N8 (padrão duro na mesma linha)
nasceu de um risco identificado no desenho, não de um defeito observado.

## Timebox

- Passos 1–8: uma sessão.
- Passo 9: ~6 min (medido: ver `07-evidence.md`).
- **Sem** dependência de rede, banco, credencial ou da plataforma bloqueada.
