# Runbook — evidência de performance (§35)

## Quando é exigida

Um PR (ou commit) que **afirma** ganho ou conserto de performance — título, corpo,
mensagem de commit, ledger ou comentário — precisa de um artefato em
`docs/evidence/` com os 7 rótulos de §35. Exemplos que disparam a exigência:

- "reduz o p50 de X em Y%", "corta RTs", "corrige N+1", "melhora o LCP";
- mudança de índice/query/read-model declarada como ganho;
- qualquer número before/after citado para justificar `keep`.

Refatoração sem alegação de performance não exige o artefato — mas se um número
for citado no PR, a evidência passa a ser exigida.

## Como preencher

1. Copie `docs/evidence/_templates/performance-evidence.md` para
   `docs/evidence/<tema>-<data>.md`; use o nome `perf-*.md`/`*-perf-*.md` (é o
   padrão que o gate varre).
2. Preencha o cabeçalho: **ambiente** (`dev-evidence` ou `CONTROLLED`, nunca
   misturados), **método**, **n**, **janela** (UTC) e **fonte**.
3. Preencha os 7 rótulos: `hypothesis`, `metric`, `before`, `change`, `after`,
   `result`, `decision` (`keep`/`revert`/`follow-up`). Cada rótulo é um campo
   `**rótulo:**` no início de uma linha.
4. Versione o raw que sustenta os números (`.jsonl`/`.json`/`.txt` em
   `docs/evidence/<tema>-<data>/`). `/tmp`, `artifacts/`, `logs/` e `raw/` são
   gitignored e não servem como fonte.
5. Rode `npx vitest run src/test/perf-evidence.test.ts` (ou `npm run test`).

## Gate

- `src/test/perf-evidence.test.ts` descobre por **caminho**: todo `.md` sob um
  diretório `docs/evidence/perf-<tema>-<data>/` (o `report.md` gerado inclusive)
  e todo `.md` cujo nome case `perf-*.md`/`*-perf-*.md`. Ignora `_templates/**` e
  `agent-state/**` (árvore de fluxo da missão) e exige os 7 rótulos dos artefatos
  restantes, com descoberta vazia **reprovando** (fail-closed). Em falha, a
  mensagem aponta o arquivo e o(s) rótulo(s) ausente(s).
- O bloco §35 do `report.md` gerado **não** é mantido à mão desde o WP-1b
  (commit `9f6f158`): `scripts/perf/summarize.mjs` o emite a partir do raw, com
  os rótulos de julgamento declarados em `meta.section35.<rótulo>` quando for o
  caso (ver `docs/evidence/_templates/performance-evidence.md`).
- Não há allowlist nem isenção de legado (WP-1c): todo artefato descoberto é checado
  contra os 7 rótulos (`checked === discovered`). Os dois artefatos de legado de
  2026-08-29 (`perf-baseline-2026-08-29.md`, `perf-after-2026-08-29.md`, regime
  `dev-evidence` com raw em `/tmp` não versionado) carregam o bloco §35 no próprio
  arquivo, com `N/A` + lacuna declarada onde o log bruto não permite re-derivar.
  `explain-critical-queries-2026-08-21.md` segue fora da varredura: não casa nenhum
  predicado de caminho.
- O gate roda no `npm run test` e no CI pesado (`ui-stack`); um artefato novo
  fora do padrão deixa a árvore vermelha.

## Rótulos de ambiente

- `dev-evidence`: log/sessão de dev, single-user, sem build de produção — os
  números **não** extrapolam para produção e não sustentam SLO.
- `CONTROLLED`: harness local/mockado (ex.: M-06), repetível e com seed
  determinístico.
- `OBSERVED`: tráfego real autorizado (H-6); nunca misturar com `CONTROLLED`.

Referência de spec: `docs/specs/M-06/definition-of-done.md` (§1).
