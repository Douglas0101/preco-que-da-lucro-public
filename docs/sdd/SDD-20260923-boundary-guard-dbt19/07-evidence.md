# 07 — Evidência · SDD-20260923-boundary-guard-dbt19

## Veredicto deste ciclo: **STOP correto antes do encadeamento**

A aprovação do contrato (`APPROVE_ADR_030=yes`) impôs a ordem **casos negativos primeiro** e a regra:
_"Nenhum gate novo pode ser adicionado antes de provar que ele sabe reprovar."_ Executados T1–T5, a
prova **reprovou para uma das duas guardas** — então o encadeamento (T6) **não** foi feito.

> `m02:boundaries` sabe reprovar. **`m02:secrets-audit` não sabe reprovar por segredo** — ele detecta e
> sai `0`. Encadeá-lo daria **cobertura de segredo apenas aparente**.

## Provas executadas (fixtures isolados; o repositório real nunca foi mutado)

| #      | Cenário                                                       | Resultado medido                                                                                                  |
| ------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **A1** | `m02:boundaries`, matriz intacta (controle positivo)          | `M-02 BFF boundary is clean…` · **exit 0**                                                                        |
| **A2** | `m02:boundaries`, `databasePaths` não-allowlisted             | `- src/lib/break-even.functions.ts -> src/not-allowlisted/evil.server.ts` · **exit 1** ✅ falsificável            |
| **A3** | `m02:boundaries`, matriz ausente                              | stack cru do `node:fs` · **exit 1** — fail-closed, mas **não distingue precondição de violação** (AC-02 pendente) |
| **B1** | `m02:secrets-audit` via `auditSecrets`, literal `ghp_…` falso | `possible_secret_literals: [{path: "src/leak.ts", line: 1, …}]` · `coverage.failures: []` ✅ **detecta**          |
| **B2** | `m02:secrets-audit` **CLI** com o mesmo literal presente      | `result: COMPLETE_WITH_LIMITS` · **exit 0** ❌ **não reprova**                                                    |

## Causa raiz (código, não opinião)

`scripts/m02-secrets-audit.ts` (bloco `main`) decide o exit code **apenas** por cobertura:

```js
process.exitCode = report.coverage.failures.length ? 2 : 0;
```

`possible_secret_literals` é **populado** (três padrões: PEM, `ghp_`/`github_pat_`/`sk-proj-`, `AKIA…`)
mas **não participa do veredicto**. O contrato real da guarda é, portanto, **mapa de consumidores com
cobertura fail-closed** — o que o teste existente `src/test/m02-secrets-audit.test.ts` já documenta
(`result === "INCOMPLETE"`, `coverage.failures`), e **não** um gate de segredo.

## Closure test versionado

`src/test/m02-boundary-gate.test.ts` — **5 casos, 815 ms**:

- `T1` boundaries verde na árvore real (sem falso positivo, com toda a evidência local presente);
- `T2` boundaries **RED** com boundary violada, em fixture isolado (com controle positivo **antes** da
  mutação, provando que o RED vem da violação e não do fixture);
- `T4` boundaries **não** devolve sucesso com a matriz ausente (fail-closed);
- `T5` audit **detecta** o literal e **não vaza o valor** (`JSON.stringify(report)` não contém o falso
  segredo);
- **`GAP DECLARADO`** — tripwire de dívida: asserta que o CLI do audit sai `0` na presença do literal,
  com instrução explícita de **inverter a asserção** quando a guarda for corrigida. Uma dívida que não
  pode ser esquecida.

O literal falso é **montado em runtime** (`ghp_` + `"A".repeat(40)`), então o segredo completo nunca
aparece no arquivo versionado — e o próprio audit exclui `*.test.*` por nome, de modo que o fixture não
contamina a varredura do repositório.

## Desvio declarado do plano original (errata)

O plano (`04-plan.md` T3) previa **mutar `docs/specs/M-02/matrix.yaml` e restaurar por sha256**
(RISK-02). A implementação encontrou caminho estritamente melhor: como o guard lê **apenas** a matriz e
usa `existsSync` nos caminhos de catálogo (sem `readdir`), basta copiar o script e a matriz para um
`mkdtemp` e criar placeholders dos caminhos de catálogo. **O repositório real nunca é mutado** — RISK-02
deixa de existir, e o caso negativo passa a rodar dentro de `npm run test`.

## O que **não** foi feito (e por quê)

- **T6 (encadeamento): NÃO executado.** Bloqueado pela prova B2, conforme a condição #1 da aprovação.
- **Nada de gate foi tocado:** `package.json`, `npm run check`, `ui-stack.yml`, `ci-light.yml` e
  `AGENTS.md` permanecem **inalterados**.
- **Nenhuma guarda foi modificada.** Duas correções estão identificadas e **não** aplicadas:
  1. `boundaries` — separar `1` (violação) de `2` (precondição): **dentro** do contrato aprovado (AC-02);
  2. `secrets-audit` — fazer o exit code considerar `possible_secret_literals`: **fora** do contrato
     aprovado, porque `ADR-030` §4 declara como não-objetivo _"não alterar a semântica dos guards"_.

A correção (2) é a que destrava o encadeamento das duas. Como ela muda **quando** uma guarda
compartilhada falha, exige decisão humana — este é o ponto exato de parada.

## Rastreabilidade

| AC                                                        | Estado                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| AC-01 (falha com boundary violada)                        | **✅ provado** — A2 / T2                                                                 |
| AC-02 (precondição ≠ sucesso, distinta)                   | **parcial** — A3/T4 provam fail-closed; a **distinção** `1`×`2` não existe ainda         |
| AC-03 (verde na árvore atual, sem falso positivo)         | **✅ provado** — A1 / T1                                                                 |
| AC-04 (closure test executável)                           | **✅ entregue** — `src/test/m02-boundary-gate.test.ts` (5 casos)                         |
| AC-05/AC-06 (custo ≥3 execuções, ≤3 s)                    | **✅ medido** — 240/204/197 ms e 1781/1802/1828 ms; teste novo: 815 ms                   |
| AC-07…AC-10 (offline, sem DB, sem segredo, metadata-only) | **✅ verificado** — imports só `node:fs`/`node:path`/`node:url`; execução local sem rede |
