# 01 — SPEC · SDD-20260923-local-ci-hardening

- **ID:** `SDD-20260923-local-ci-hardening`
- **Status:** `EXECUTADO (escopo aprovado) — 2026-09-24`. O item 5 foi aprovado sob `APPROVE_ITEM_5=yes`
  com o escopo **A–F** (ruído do scan, contagens/`measuredAt`, `manifest.sha256` no selo, pré-condição de
  árvore suja, flake do e2e, inventário de worktrees) e **executado**. **Esta SPEC original não é o
  mesmo conjunto:** dos seus `REQ-01…REQ-09`, **apenas `REQ-09` foi implementado** e `REQ-06` ficou
  parcial — os outros sete seguem **abertos** como backlog. O confronto completo está em
  **`09-reconciliation.md`**, que é a leitura obrigatória antes de usar esta SPEC como se estivesse
  cumprida.
- **Data:** 2026-09-23 (spec) · 2026-09-24 (reconciliação)
- **Nota de estrutura:** este SDD nasceu **spec-only**; na execução expandiu-se no conjunto
  multi-arquivo (`02-acceptance.md` … `09-reconciliation.md`).

## 1. Problema

O `scripts/local-ci.sh` foi escrito **sob pressão de bloqueio de billing** e provou-se útil em duas
execuções reais (359 s, `verdict=success`, 28 etapas). Ainda assim, três classes de fragilidade ficaram
**medidas** e não fechadas:

1. **Achado da rodada 1 (defeito meu, corrigido emergencialmente):** o eco do comando imprimia os
   **segredos efêmeros** gerados para o tier de e2e. Foi corrigido com `redact()`, mas sem teste que
   impeça a regressão.
2. **Latente (corrigido durante a rodada 2):** duas construções `[ … ] && cmd` em posição de topo sob
   `set -Eeuo pipefail`. Hoje são inócuas (o teste não é o comando após o `&&` final), mas são frágeis a
   refatoração e não há verificação estática.
3. **Estrutural:** o script **não tem teste próprio**. Não existe caso que falsifique a cobertura, o
   `redact`, o cálculo de escopo nem a política de evidência. Um pipeline de 28 etapas sem teste do
   próprio instrumento é, ele mesmo, um ponto único de falha silenciosa.

## 2. Contexto

- `shellcheck` **não** está instalado no ambiente (verificar na execução; se ausente, é precondição
  declarada, não skip silencioso).
- O repo já tem precedente forte de teste de guarda: `src/test/m02-ci-tiers.test.ts` executa o **script
  real extraído do YAML** em fixture de git — o instrumento é testado, não apenas usado.
- Os campos de política de evidência e o `evidence.git.sha256` já entraram neste ciclo
  (`SDD-20260923-evidence-policy`); o hardening cobre o **resto**.

## 3. Objetivo

Tornar o `local-ci` um instrumento **testado e falsificável**: cada propriedade de segurança e de
cobertura com um caso que a derruba quando ela deixa de valer.

## 4. Não objetivos

- Não transformar o `local-ci` em gate de CI remoto (decisão separada, com ADR).
- Não adicionar dependência nova (nem `shellcheck` como dependência obrigatória: se ausente, declara).
- Não reescrever o script por estética; refatorar só onde compra testabilidade.

## 5. Requisitos

- **REQ-01 — redaction testada.** Um caso que injeta variável sensível (nome casando
  `PASSWORD|SECRET|TOKEN|CREDENTIAL|KEY`) e senha dentro de URL, e **reprova** se o valor aparecer no
  eco. Controle negativo: sem `redact`, o caso falha.
- **REQ-02 — verificação estática.** `bash -n` no script; e `shellcheck` **quando disponível** (declarando
  a ausência como precondição, com exit distinto, nunca skip silencioso).
- **REQ-03 — ausência de armadilhas de `set -e`.** Verificador que reprova `cmd && cmd2` em posição de
  topo dentro de função (a forma que aborta sob `set -e` quando o primeiro comando falha), ou que
  documente cada ocorrência legítima.
- **REQ-04 — cobertura por identidade.** O `coverage_check` já usa igualdade; falta o **controle
  negativo**: remover uma etapa do encadeamento deve **reprovar** (hoje não há prova disso).
- **REQ-05 — escopo testado.** Casos de tabela para a regex de escopo: diff de banco ⇒ `db=true`; diff só
  de docs ⇒ `db=false`; **base desconhecida ⇒ `db=true`** (fail-closed); base não-ancestral ⇒ `db=true`.
- **REQ-06 — política de evidência testada.** Estende o controle negativo de
  `SDD-20260923-evidence-policy/AC-05`.
- **REQ-07 — preservação por idempotência.** Rodar duas vezes no mesmo SHA **não** mistura rodadas: a
  segunda arquiva a primeira em `_archive/` (comportamento já implementado; falta o teste).
- **REQ-08 — `--fast` seguro e declarado.** Modo que reduz custo **sem** remover verificação: pula
  etapas caras (e2e, `check` agregado) **marcando-as como `skipped` com motivo**, nunca como `success`.
  Proibido: qualquer modo que faça o veredicto parecer verde sem ter rodado.
- **REQ-09 — falha alta em contradição de manifesto.** Se o manifesto citar log que o Git versionaria, ou
  omitir contagem, o pipeline reprova (liga com a etapa `evidence-policy-check`).

## 6. Critérios de aceite (a expandir na execução)

- **AC-01** os casos de REQ-01/REQ-04/REQ-05 passam, e **cada um tem controle negativo capturado**.
- **AC-02** suíte do instrumento roda dentro de `npm run test` (ou etapa própria encadeada) — não pode
  ser um script que ninguém executa.
- **AC-03** nenhuma etapa existente é removida; `local-ci` continua verde no HEAD vigente.
- **AC-04** `checked === discovered`: o número de propriedades declaradas nesta SPEC iguala o número de
  casos implementados; lacuna reprova.

## 7. Design (resumo)

- Suíte em `src/test/local-ci-script.test.ts` (vitest), no padrão de `m02-ci-tiers.test.ts`: **executa o
  script real**, não uma cópia.
- Extração por função: `redact` e o cálculo de escopo viram funções puras testáveis por `bash -c 'source
<(sed -n …)'` ou por extração textual — evitando duplicar lógica no teste (duplicar criaria a
  divergência que o teste deveria pegar).
- Fixture de git em `mkdtemp` para escopo e arquivamento; **nunca** contra o repositório real.

## 8. Plano (resumo)

T1 extração testável de `redact`/escopo → T2 casos + controles negativos → T3 encadeamento no `test` →
T4 `--fast` com skips nomeados → T5 rodada completa de validação. Ordem obrigatória: casos **antes** de
`--fast` (não se adiciona modo novo a instrumento sem teste).

## 9. Riscos (resumo)

- **RISK-01** o teste duplicar a lógica e mascarar divergência ⇒ mitigar executando o script real.
- **RISK-02** `--fast` virar porta de saída para verde falso ⇒ mitigação: skips nomeados e proibição de
  `success` sem execução; veredicto de modo `--fast` é rotulado.
- **RISK-03** `shellcheck` ausente ⇒ precondição declarada com exit distinto, nunca skip.
- **RISK-04** mexer no script que é a **única** fonte de verificação atual ⇒ rodar a validação completa e
  comparar com a evidência anterior antes de considerar pronto.

## 10. Traceabilidade

REQ-01…REQ-09 → T1…T5 → AC-01…AC-04. **Lacunas:** nenhuma declarada; a expandir na promoção.

## 11. Dependências e aprovações

- Nenhuma dependência de rede/plataforma/banco.
- **Aprovação humana necessária** para: encadear a suíte no `check` (muda contrato de CI) e para o ADR,
  se o `local-ci` passar a ser gate oficial.
