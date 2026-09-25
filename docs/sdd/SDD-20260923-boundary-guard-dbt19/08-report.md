# 08 — Relatório · SDD-20260923-boundary-guard-dbt19

## Veredicto

**`EXECUTADO` — contrato implementado, validado e com closure test.** DBT-19 está tecnicamente fechada;
o registro no registry depende do MAESTRO.

## Trajetória do ciclo (o que aconteceu de fato)

1. **Contrato aprovado** com a condição: casos negativos **antes** do encadeamento.
2. **A prova reprovou para uma das guardas** → **STOP** correto, com diagnóstico.
3. **Decisão humana (opção a)** → corrigir o veredicto do `secrets-audit` e encadear as duas.
4. **Implementação + validação** → `npm run check` exit 0, `local-ci` `verdict=success`.

O passo 2 é o que dá valor ao ciclo: sem ele, o encadeamento teria produzido **cobertura de segredo
aparente** — um gate que existe, aparece verde e não reprova no que o nome promete.

## O que mudou

| Arquivo                              | Mudança                                                                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/m02-secrets-audit.ts`       | veredicto distingue `2` (precondição/cobertura), `1` (literal detectado), `0` (limpo); stderr nomeia `arquivo:linha` e **nunca** o valor |
| `scripts/m02-boundaries.ts`          | matriz ilegível ⇒ **precondição `2`**, distinta da violação `1` (AC-02)                                                                  |
| `package.json`                       | as duas guardas na cadeia `check` (14 → **16** membros)                                                                                  |
| `.github/workflows/ui-stack.yml`     | as duas como passos diretos do `verify`, na mesma posição relativa                                                                       |
| `AGENTS.md`                          | tabela de cobertura, lista da cadeia, "14 dos 16" e a baseline de segurança — no mesmo commit                                            |
| `src/test/m02-boundary-gate.test.ts` | 6 casos; o tripwire de dívida foi **invertido** conforme a instrução que ele mesmo carregava                                             |
| `scripts/local-ci.sh`                | precondição que recusa (exit 2) selar com árvore suja fora da evidência                                                                  |

## Aceite × medido

| AC                                              | Estado                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| AC-01 falha com boundary violada                | ✅ exit 1 nomeando o caminho                                                     |
| AC-02 precondição distinta de violação          | ✅ exit 2 (`boundaries`) e exit 2 (`audit`), contra exit 1 de violação           |
| AC-03 verde na árvore atual, sem falso positivo | ✅ `npm run check` exit 0 e `local-ci` verde com toda a evidência local presente |
| AC-04 closure test executável                   | ✅ 6 casos em `npm run test`                                                     |
| AC-05/AC-06 custo ≥3 execuções e ≤3 s           | ✅ 208 ms e 1987 ms (médias de 3)                                                |
| AC-07…AC-10 offline/DB/segredo/metadata-only    | ✅ imports só `node:fs`/`node:path`/`node:url`; nenhum valor ecoado              |

## Dois defeitos **meus**, achados no caminho e fechados

1. **Evidência mal-rotulada.** Uma rodada do `local-ci` executou com a **árvore suja** e selou evidência
   com `headSha = 36c4bde` — um SHA que **não continha** o conteúdo validado. A rodada foi **arquivada**
   com `MISLABEL-DECLARADO.md` (não citável como evidência daquele commit) e o instrumento ganhou
   precondição que recusa selar com entradas sujas fora de `docs/evidence/local-ci/`, com escape
   declarado `LOCAL_CI_ALLOW_DIRTY=1` — **testado contra a árvore suja real, reprovando como esperado**.
2. **Defeito de protocolo do journal.** A linha de intenção `L165` foi gravada **depois** das mutações
   que descreve (quinta ocorrência da série `L142`/`L144`/`L146`/`L150`) — declarada em vez de
   back-datada.

## Falha investigada e **refutada**

A primeira re-selagem teve **e2e vermelho** (1 de 30: o login não redirecionava para `/inicio`), e a
correlação era exata — as 4 rodadas com `db:test` pulado tiveram e2e verde, e a única com o tier de
banco executado teve e2e vermelho. **Hipótese testada e refutada por experimento controlado:** com
`db:test` rodando antes do e2e no **mesmo** container efêmero, o e2e passou **30/30**. A re-selagem
seguinte passou com `db:test` **e** e2e verdes. Conclusão: **transiente** (`playwright.config.ts` tem
`retries: 0`, então um único timeout custa a rodada), não interação entre tiers.

## Reversão

`git revert c7e6a55` restaura o estado anterior (guarda sem o veredicto por literal, cadeia com 14
membros). `git revert 36c4bde` remove o teste de fechamento. Nada de runtime é afetado.
