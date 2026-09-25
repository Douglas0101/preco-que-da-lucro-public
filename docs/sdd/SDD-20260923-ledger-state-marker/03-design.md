# 03 — Design · SDD-20260923-ledger-state-marker

## 1. Resumo da solução

Adicionar um **bloco novo** ao fim de `EXECUTION-STATE-PROGRAM.md`, descrevendo o ciclo, e terminar o
bloco com a linha viva do marcador:

```text
  Latest state marker parent = `8683c2dbe46a98eb98be7a734cbc951e00cfa6b5`,
```

Como o commit da correção terá `8683c2d` como **parent**, `m02:state:check` passa a aceitar a âncora
no novo HEAD (`ledger.includes(parentPinnedMarker)`), e o boot seguinte volta a verde.

## 2. Alternativas consideradas

| #      | Alternativa                                                                  | Por que não                                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1     | Editar **in-place** a linha final (2555), trocando `41e776b…` por `8683c2d…` | Reescreve conteúdo histórico do ledger. Funciona para o check, mas apaga o registro de que o marcador já esteve em `41e776b`, e mistura duas rodadas no mesmo bloco. Viola a preferência declarada "adicionar a apagar". |
| A2     | Usar a âncora exata `` `HEAD` = `<sha>` ``                                   | Amarra o ledger a um SHA **exato**, o que quebra no commit seguinte (é o defeito que o parent-pinned existe para evitar). O repo já abandonou essa forma.                                                                |
| A3     | Tornar `m02:state:check` bloqueante no `check`                               | Muda contrato de gate fora de escopo, tornaria o CI remoto mais estrito do que ele é hoje, e transformaria dívida de bookkeeping em falha de código. Fica para o item 6 (hardening) com SPEC própria.                    |
| A4     | Corrigir por `--amend` no commit anterior                                    | **Proibido** (§3.6). Reescreve história, ainda que local e não pushada.                                                                                                                                                  |
| **A5** | **Bloco novo aditivo com o marcador do parent**                              | **Escolhida.** Append-only, sem reescrita, alinhada à convenção acumulativa já visível no arquivo (dezenas de marcadores históricos preservados) e ao protocolo do journal.                                              |

## 3. Decisão escolhida

**A5.**

## 4. Justificativa

- O check usa `includes`, logo um bloco novo satisfaz a condição sem tocar o passado.
- O arquivo já é **acumulativo por construção**: cada ciclo deixou o seu marcador. A linha 2555 não é
  "a linha do marcador", é o marcador **do ciclo anterior**.
- Preserva rastreabilidade: quem ler o ledger vê que o marcador andou de `41e776b` para `8683c2d`.
- Zero risco de runtime: arquivo documental.
- Zero dependência externa: não toca a plataforma bloqueada.

## 5. Impacto em arquivos

| Arquivo                                 | Mudança                                                                       |
| --------------------------------------- | ----------------------------------------------------------------------------- |
| `EXECUTION-STATE-PROGRAM.md`            | bloco novo aditivo ao fim (+ marcador)                                        |
| `docs/evidence/agent-state/PROGRESS.md` | linhas `L159` (`▶`) e `L160` (`✔`) no journal; §1 com refs atualizadas        |
| `docs/TODO.md`                          | novo arquivo (fila do agente)                                                 |
| `docs/sdd/SDD-20260923-*/**`            | novos (specs deste ciclo)                                                     |
| `scripts/local-ci.sh`                   | campos de política de evidência + `evidence.git.sha256` (item 3, SDD próprio) |

## 6. Impacto em CI

- `ui-stack.yml` (heavy): o commit toca `EXECUTION-STATE-PROGRAM.md`, que está **fora** de
  `docs/evidence/**` — portanto **não** cai no `paths-ignore` e a heavy rodaria. Como a cota está
  bloqueada, **não haverá push**, logo nenhum run é disparado.
- `ci-light.yml`: só dispara em push cujos arquivos estejam **todos** sob `docs/evidence/**`; este
  commit mistura raiz + `docs/**`, então não é caso de light.
- Impacto **nulo** enquanto não houver push. Registrado porque é exatamente a armadilha do `L154`
  (um push de documentação na raiz do ledger disparou a heavy e queimou cota sem produzir evidência).

## 7. Impacto em ledger/journal

É o próprio objeto da mudança. O journal ganha `▶` antes e `✔` depois; a §1 passa a declarar as refs
corretas (`develop` deixa de ser `e61c9f4`).

## 8. Impacto em evidência

O `local-ci` roda no novo HEAD e sela evidência em `docs/evidence/local-ci/<novo-sha>/`, com a etapa
`m02:state:check` agora **success** — a prova do aceite.

## 9. Impacto em segurança

Nenhum. Nenhum segredo, nenhuma credencial, nenhuma superfície de rede. O bloco novo cita apenas SHAs
públicos do próprio repositório.

## 10. Impacto em performance

Nenhum (documento não é lido em runtime).

## 11. Estratégia de rollback

`git revert <commit>` — aditivo, então o revert simplesmente remove o bloco novo. Nada mais depende dele.

## 12. Pontos de observabilidade

- `npm run m02:state:check` (exit code + mensagem).
- `steps.tsv` / `manifest.json` da evidência do novo HEAD: `m02:state:check` = `success`.
- `git diff --numstat` do commit (prova de que é aditivo).

## 13. Casos de falha

| Caso                                              | Sintoma                                  | Tratamento                                                                                       |
| ------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Bloco novo cita um SHA que não resolve            | `m02:temporal-guard` reprova (âncora T2) | usar somente SHAs verificados por `git rev-parse`                                                |
| Bloco novo usa data passada após verbo de prazo   | `m02:temporal-guard` reprova (T1)        | evitar verbo de prazo; declarar datas de forma absoluta                                          |
| Prettier reformata o bloco                        | `format:check` reprova                   | rodar `prettier --write` no arquivo antes do commit                                              |
| O commit seguinte esquece de atualizar o marcador | check volta a ficar vermelho             | é a disciplina "o marcador é parte do commit" — aqui, cada commit deste ciclo inclui a sua linha |
