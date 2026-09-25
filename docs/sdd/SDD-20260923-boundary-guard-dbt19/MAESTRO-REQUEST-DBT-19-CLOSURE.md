# Pedido ao MAESTRO — fechamento de `DBT-19` no registry

> **Por que este arquivo existe e não uma edição no registry:** `docs/evidence/agent-state/DEBTS.md`
> declara o **MAESTRO** como escritor (assim como `QUEUE.md`). O agente **não** edita nenhum dos dois.
> Este é o pedido auditável de fechamento, com o closure test já executável.

- **Solicitante:** agente supervisionado, ciclo `SDD-20260923`
- **Data:** 2026-09-23
- **Dívida:** `DBT-19` — status atual no registry: **ABERTA**
- **ADR:** `docs/adr/ADR-030-boundary-guard-dbt19.md` (aprovado como contrato; errata §9 registra o
  achado que mudou o plano no meio do caminho)

## Estado técnico: **implementação local concluída e validada**

### Condição de fechamento do registry (verbatim) × como foi cumprida

> _"Fechada quando ambos aparecem no encadeamento de um pipeline **com um caso negativo que os
> falsifica** (guard que nunca reprova não é guard) e a tabela de cobertura do `AGENTS.md` bate com os
> YAMLs por asserção de teste."_

| Cláusula                                | Cumprimento                                                                                                                                                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ambos no encadeamento de um pipeline    | `npm run check` (cadeia, 16 membros) **e** passos diretos do `verify` do `ui-stack.yml`                                                                                                                         |
| **caso negativo que os falsifica**      | `src/test/m02-boundary-gate.test.ts` — **6 casos**: boundary violada ⇒ exit 1; precondição ⇒ exit 2; literal de segredo ⇒ exit 1; cobertura incompleta ⇒ exit 2; verde na árvore real; detecção sem vazar valor |
| tabela do `AGENTS.md` bate com os YAMLs | tabela, lista da cadeia e contagem ("14 dos 16") atualizadas **no mesmo commit** do encadeamento                                                                                                                |

### Achado que **mudou o plano** (e é o motivo de a dívida valer a pena ter sido perseguida)

`m02:secrets-audit` **detectava** literais de segredo (`possible_secret_literals`, três padrões: PEM,
`ghp_`/`github_pat_`/`sk-proj-`, `AKIA…`) e **saía `0`** — o veredicto olhava **apenas** a cobertura
(`coverage.failures.length ? 2 : 0`). Encadeá-lo sem corrigir isso teria produzido **cobertura de segredo
apenas aparente**: o pior resultado possível, porque pareceria resolvido. O exit code passou a
distinguir `2` (precondição), `1` (literal) e `0` (limpo), nomeando `arquivo:linha` em stderr e **nunca**
o valor.

## Closure test

```text
src/test/m02-boundary-gate.test.ts   →  6 casos, ~1,1 s
```

Roda em `npm run test` (já encadeado no `check`), portanto **executável por gate**, não por cortesia.

## Custo medido (3 execuções cada, nesta máquina)

| Guarda                                                 |  exec 1 |  exec 2 |  exec 3 |       média |
| ------------------------------------------------------ | ------: | ------: | ------: | ----------: |
| `m02:boundaries`                                       |  213 ms |  202 ms |  210 ms |  **208 ms** |
| `m02:secrets-audit`                                    | 2101 ms | 1926 ms | 1934 ms | **1987 ms** |
| trecho encadeado (`temporal→boundaries→secrets-audit`) | 2356 ms | 2345 ms | 2280 ms | **2327 ms** |

`npm run check` exit 0; `local-ci` `verdict=success` (351 s) no commit selado.

## Evidência

- `docs/evidence/local-ci/c7e6a558e0da3abc7e30e36ab698d0119e078b80/` — rodada completa, **árvore limpa**
  fora da evidência (`git-status.txt` só tem entradas sob `docs/evidence/local-ci/`), tier de banco
  **executado e verde**, e2e verde, `pendencies` vazio.
- `docs/sdd/SDD-20260923-boundary-guard-dbt19/07-evidence.md` — as provas de falsificabilidade.
- Commit `c7e6a55` (`ci(guards): chain m02:boundaries and m02:secrets-audit into check`).

## Ação requerida do MAESTRO

1. Avaliar o fechamento de **`DBT-19`** no registry, com closure test apontando para
   `src/test/m02-boundary-gate.test.ts` e evidência no commit `c7e6a55`.
2. Se aceito, escrever a linha no `DEBTS.md` (o agente não escreve).

## O que este pedido **não** pede

- Não pede push, billing, status no GitHub, `full-logs` ou mudança de visibilidade.
- Não pede fechamento de `DBT-23` (pedido separado, em `SDD-20260923-evidence-policy/MAESTRO-REQUEST-DBT-23.md`).
- Não pede ratificação do ADR-030 (decisão humana própria, se desejada).
