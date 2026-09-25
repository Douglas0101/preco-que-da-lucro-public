# 08 — Relatório · SDD-20260923-ledger-state-marker

## Veredicto

**`EXECUTADO` — objetivo cumprido.** `m02:state:check` passou de **vermelho** para **verde**, sem
reescrever história, e o verde sobreviveu ao commit seguinte do ciclo.

## O que foi feito

1. Bloco **aditivo** `### Ciclo SDD-20260923` no fim de `EXECUTION-STATE-PROGRAM.md`, com o marcador
   vivo `Latest state marker parent = 3c088b6…` (commit A) e depois `86565f0…` (commit B).
2. Journal com `L159` (`▶`, antes da mutação) e `L160` (`✔`, depois).
3. §1 do journal atualizada: `develop` deixou de ser declarado como `e61c9f4`.

## Aceite × medido

| AC    | Critério                                         | Resultado                                                    |
| ----- | ------------------------------------------------ | ------------------------------------------------------------ |
| AC-01 | `m02:state:check` verde no novo HEAD             | **OK** — EV-02, EV-04                                        |
| AC-02 | vermelho **antes** (controle negativo)           | **OK** — EV-01                                               |
| AC-03 | correção aditiva (`0` deleções no ledger)        | **OK** — `+29 -0`                                            |
| AC-04 | âncoras resolvem (guard temporal)                | **OK** — EV-06                                               |
| AC-05 | formatação preservada                            | **OK** — `format:check` exit 0                               |
| AC-06 | pipeline verde no novo HEAD, com a etapa nomeada | **OK** — `verdict=success`, 311 s, `m02:state:check success` |
| AC-07 | nenhum push                                      | **OK** — `origin/develop` e `origin/main` inalterados        |
| AC-08 | journal `▶` antes / `✔` depois                   | **OK** — `L159`/`L160`                                       |

## Custo

- 2 commits locais (`3c088b6`, `86565f0`), nenhum push.
- 1 execução completa do pipeline: **311 s** (~5,2 min).

## Causa raiz — o que este SDD **não** fecha

O marcador defasou porque `m02:state:check` **não pertence a gate nenhum**: não está na cadeia
`npm run check`, não é passo direto do `verify` do `ui-stack` e não roda na light. Enquanto isso não
mudar, a disciplina depende de quem commita — e o verde de hoje é **restauração**, não prevenção.

Encadear o check num pipeline é **mudança de contrato de CI** e exige decisão humana; está especificado
em `docs/sdd/SDD-20260923-boundary-guard-dbt19/01-spec.md` (mesma classe de lacuna: gate declarado que
não roda) e registrado em `docs/TODO.md`.

## Reversão

`git revert 3c088b6` (e `86565f0`, que só acrescenta evidência e o marcador). Mudança documental
aditiva; nenhum efeito em runtime.
