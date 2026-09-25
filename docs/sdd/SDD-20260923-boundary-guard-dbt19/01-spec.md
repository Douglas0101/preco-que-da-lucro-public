# 01 — SPEC · SDD-20260923-boundary-guard-dbt19

- **ID:** `SDD-20260923-boundary-guard-dbt19`
- **Status:** `SPEC COMPLETA` — **aguardando aprovação de contrato** (ADR-030 em PROPOSTA; **nada
  implementado**: `package.json`, `npm run check`, workflows e `DEBTS.md` intocados)
- **Data:** 2026-09-23
- **Conjunto:** SPEC + `02-acceptance` + `03-design` + `04-plan` + `05-risk` + `06-traceability`
- **ADR:** `docs/adr/ADR-030-boundary-guard-dbt19.md`
- **Medição de custo e precondições:** feita neste ciclo (T0 do plano) — 213 ms e 1803 ms médios,
  ambas sem rede/DB/plataforma

## 0. Requisitos (identificadores canônicos)

- **REQ-01** — a guarda é **fail-closed**: violação ⇒ exit ≠ 0.
- **REQ-02** — **closure test** executável e encadeado num runner.
- **REQ-03** — **casos negativos** que falsifiquem cada guarda.
- **REQ-04** — **medição de custo** (≥ 3 execuções por guarda).
- **REQ-05** — integração ao `npm run check`, **ou** alternativa justificada por escrito.
- **REQ-06** — compatível com a política de evidência `metadata-only`.
- **REQ-07** — compatível com `_archive/` e demais artefatos locais declarados.
- **REQ-08** — nenhum acesso remoto.
- **REQ-09** — nenhum billing.
- **REQ-10** — nenhum segredo exposto.

Os critérios de aceite correspondentes (`AC-01`…`AC-10`) estão em `02-acceptance.md`, com o estado
medido de cada um. A rastreabilidade REQ→TASK→AC→EV está em `06-traceability.md`.

## 1. Problema

**DBT-19** (registry de dívidas, `docs/evidence/agent-state/DEBTS.md`, status **ABERTA**) registra que
**dois guards declarados contrato não rodam em push de código**:

- `m02:boundaries` — não aparece em `npm run check`, nem no passo direto do `verify` (heavy), nem na
  light. **Gate nenhum.** Verde medido **à mão** em 2026-09-22: _"M-02 BFF boundary is clean"_.
- `m02:secrets-audit` — roda **só** na light (`ci-light.yml`), que dispara apenas quando **todos** os
  arquivos alterados estão sob `docs/evidence/**`. Um push **só de código** nunca o executa.

A tabela de cobertura do `AGENTS.md` documenta essa lacuna honestamente (marca `✘` nomeado) — mas
**documentar não é executar**. O próprio `AGENTS.md` diz: _"Declarar contrato e não executá-lo é a
lacuna, não a guarda."_

**Condição de fechamento declarada por DBT-19 (verbatim):** fechada quando ambos aparecem no encadeamento
de um pipeline **com um caso negativo que os falsifica** (guard que nunca reprova não é guard) e a tabela
de cobertura do `AGENTS.md` bate com os YAMLs **por asserção de teste**.

## 2. Contexto

- **Assimetria medida:** a light executa `m02:secrets-audit` (e os quatro guards + prettier dos arquivos
  alterados); a heavy executa os quatro guards + `format:check` + `lint` + `typecheck` + `test` + `build`,
  mas **nenhum** dos dois. Logo, a interseção de cobertura por push de código é **vazia** para ambos.
- `m02:boundaries` existe e funciona (`scripts/m02-boundaries.ts`); o problema é **não estar encadeado**.
- A lacuna foi achada pelo **próprio S6** do WP-R8 (N7), a partir da correção de uma prosa que afirmava
  "os mesmos gates" — ou seja, o achado nasceu de prosa inflada, não de código.

## 3. Objetivo

Colocar os dois guards no encadeamento de um pipeline, de modo que um push só de código os execute, com
**caso negativo que os falsifique** e com a tabela do `AGENTS.md` **assertada por teste** contra os YAMLs.

## 4. Não objetivos

- Não alterar a **semântica** dos guards (o que eles verificam).
- Não duplicar execução (rodar o mesmo guard em dois pipelines sem necessidade queima cota — o recurso
  que está bloqueado).
- Não introduzir gate que dependa de rede/credencial (o `m02:secrets-audit` hoje é node built-ins only,
  e é isso que permite a light rodar **sem instalar dependências** — propriedade a preservar).

## 5. Requisitos

Os requisitos canônicos são os **REQ-01…REQ-10** declarados na §0 deste arquivo. O detalhamento
substantivo que antes vivia aqui foi distribuído para os arquivos do conjunto, sem duplicar
identificador:

- encadeamento nos pipelines e justificativa → `03-design.md` §2;
- casos negativos, closure test e precondição → `04-plan.md` (T1–T5) e `02-acceptance.md` (AC-01…AC-04);
- medição de custo → `ADR-030` §1.3 e `02-acceptance.md` (AC-05/AC-06);
- asserção da tabela do `AGENTS.md` → `04-plan.md` (T6) e `05-risk.md` (RISK-03/RISK-04);
- preservação da propriedade "roda sem instalar dependências" → `03-design.md` §3 e REQ-08.

## 6. Critérios de aceite

Ver `02-acceptance.md` — os dez critérios `AC-01…AC-10`, cada um com comando, valor esperado e o
**estado medido** (três já medidos neste ciclo: AC-03, AC-05, AC-06, além de AC-07…AC-10 por inspeção).

## 7. Design

Ver `03-design.md`. A decisão proposta é **A2 do ADR-030**: encadear as duas guardas no
`npm run check` **e** replicá-las como passos diretos no `verify` do `ui-stack.yml`, porque a cadeia e
a lista de passos do YAML são **listas separadas** — alterar só uma recria a divergência que gerou o
achado N7.

Custo do encadeamento: **≈ 2,0 s** (medido: 213 ms + 1803 ms), contra e2e 240 s, vitest 151 s e
`db:test` 33 s que motivaram o tiering. Nada é removido nem afrouxado.

## 8. Plano

Ver `04-plan.md` — T0 (medição, **já feito**) e T1…T11 (bloqueados por aprovação do contrato).

## 9. Riscos

Ver `05-risk.md` — RISK-01…RISK-10, incluindo os riscos **aceitos conscientemente** (mutação de
`matrix.yaml` no caso negativo, com a alternativa limpa adiada) e a lista de **não-riscos verificados
por medição** (rede, banco, plataforma, segredos, runtime).

## 10. Traceabilidade

Ver `06-traceability.md` — REQ-01…REQ-10 → T0…T11 → AC-01…AC-10 → EV-D19-01…08, com
`checked === discovered` (10 requisitos, 10 linhas) e o estado de cada evidência.

## 11. Dependências e aprovações

- **Aprovação humana/contratual necessária** antes de qualquer implementação: a mudança altera contrato
  de CI (encadeia gates). O pedido está em `docs/adr/ADR-030-boundary-guard-dbt19.md` §8.
- **Enquanto não aprovado**, permanecem intocados: `package.json`, `npm run check`, `ui-stack.yml`,
  `local-ci.sh` em ponto que mude veredicto, e `DEBTS.md`.
- **Não** depende do desbloqueio de billing para ser **implementado** nem **verificado localmente** —
  ambas as guardas rodam offline; a verificação no CI remoto depende, e essa parte fica declarada.
- **Fechamento de DBT-19** exige escrita do **MAESTRO** no registry, mesmo após a implementação.
