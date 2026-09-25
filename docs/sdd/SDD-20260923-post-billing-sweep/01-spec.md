# 01 — SPEC · SDD-20260923-post-billing-sweep

- **ID:** `SDD-20260923-post-billing-sweep`
- **Status:** `SPEC` — **BLOQUEADO** aguardando o desbloqueio de billing (ação **humana**)
- **Data:** 2026-09-23
- **Nota de estrutura:** spec-only por decisão de escopo (item 7 do backlog). Expande na promoção.

## 1. Problema

Desde `2026-09-21T14:33Z` **todo** run do GitHub Actions falha em ~3–9 s com **0 passos**, com a
anotação verbatim da plataforma no check-run:

> _"The job was not started because recent account payments have failed or your spending limit needs to be
> increased."_

Classificação correta (e já adotada no repo): **falha de precondição de ambiente externo**, não veredito.
Consequência: existe uma **janela de SHAs sem verificação** — commits que entraram em `develop` sem
nenhum run verde citável. Medição mais recente (`L155`): **18 SHAs** pushed com **0 check-runs**.

O risco não é o bloqueio em si (é externo e humano). O risco é **retomar os pushes sem varrer a janela**:
um defeito introduzido na janela ficaria invisível atrás de um run verde do commit seguinte.

## 2. Contexto

- **Janela medida (18 SHAs):** os 13 declarados — `d9bc810`, `5539226`, `8f260f5`, `011c7e3`, `7e719bc`,
  `ff4c379`, `4be813c`, `8ecb584`, `9f521ed`, `6e9dac9`, `94e49aa`, `398a77c`, `a2f5ff6` — mais 5
  pushed com 0 check-runs esquecidos: `9237d01`, `a95254b`, `4eed127`, `974426b`, `f4edb66`.
- **Errata registrada:** a frase antiga "nenhum com selo" era **falsa** — **8 dos 18** tocam arquivos de
  selo. A formulação correta é "nenhum com **run verde citável**".
- **`5539226` não é probatório:** é commit **vazio**, e a plataforma **suprime execução** para commit
  vazio (achado N9 do S6 do WP-R8). A varredura não pode contar a ausência de run dele como falha.
- **Classe separada:** os commits **não pushados** (`41e776b`, `e61c9f4`, `4b44ab4`, `db5ec7a`,
  `2edb55b`, `8683c2d` + os deste ciclo) **não** estão na janela de 18 — não foram enviados. Entram na
  varredura como **push novo** quando houver aprovação, não como rerun.
- Último verde aplicável: **`f293368@35611793799`** (heavy, 30 passos).
- **Billing não é legível nem escritível por API** com o token atual (endpoints 404 / escopo ausente —
  medido no `L157`). O desbloqueio é **exclusivamente humano** (Settings → Billing & plans).
- A sonda `ci-unblock-probe` já existe e é rearmável; **cada tentativa bloqueada custa 0 min** (0 passos
  não faturam).

## 3. Objetivo

Varrer a janela e produzir, **por SHA**, evidência de verificação — sem empilhar pushes bloqueados e sem
fabricar `run@sha`.

## 4. Não objetivos

- **Não** tentar destravar billing (proibido: nenhuma ação de cobrança).
- **Não** postar status para "marcar" SHAs da janela como verificados.
- **Não** usar `rerun` em massa: `cancel-in-progress` por ref faz runs da mesma ref se cancelarem, e a
  média de custo por heavy é **9,7 min** (8 runs verdes medidos, 497–605 s).
- **Não** reescrever história para "limpar" a janela.

## 5. Requisitos

- **REQ-01 — varredura antes de qualquer land novo.** O primeiro push pós-desbloqueio roda a varredura;
  nenhum commit novo entra antes de a janela estar caracterizada (protocolo de bloqueio, item (d)).
- **REQ-02 — evidência por SHA, com filtro de amostra.** Coleta por SHA: `run@sha`, `event`, `head_ref`,
  `conclusion`, nº de passos, `run_started_at`. Runs `cancelled` **não** contam como evidência (nem verde
  nem vermelha) — regra `run@sha` do repo.
- **REQ-03 — `5539226` tratado como não-probatório** (commit vazio), com a razão registrada.
- **REQ-04 — ordem que evita auto-cancelamento:** primeiro o heavy do **tip** (fecha o item 15 — `headSha`
  descendente do selo — e abre a amostra B4); **em seguida** os demais SHAs, um por vez, sem dois heavies
  concorrentes na mesma ref.
- **REQ-05 — orçamento declarado:** custo estimado = nº de heavies × 9,7 min; se a cota for limitada,
  priorizar o tip e os SHAs que tocam **código** (`src/**`, `scripts/**`, `.github/**`, manifests) sobre
  os só-docs (que a heavy nem dispara, por `paths-ignore`).
- **REQ-06 — fallback se o billing cair de novo:** a varredura para, registra o bloqueio, e o
  `local-ci` volta a ser a fonte de verdade; nenhuma tentativa em loop (o repo já encerrou uma sonda após
  4 ciclos com a regra "não repetir infinitamente").
- **REQ-07 — nenhum `run@sha` inventado.** Selo com `run@sha` só depois de existir o run.

## 6. Critérios de aceite (a expandir)

- **AC-01** planilha por SHA com os campos de REQ-02, com a fonte de cada campo (API/`gh`) registrada.
- **AC-02** contagem `checked === discovered`: nº de SHAs da lista = nº de SHAs com linha na planilha
  (incluindo os não-probatórios, marcados).
- **AC-03** nenhum `run@sha` citado sem run existente (verificação por identidade, via API).
- **AC-04** `origin/main` permanece `9724d2c` intocado durante toda a varredura.
- **AC-05** orçamento medido ao final (minutos de runner efetivamente gastos) declarado no relatório.

## 7. Design (resumo)

Sonda → detecção do primeiro job com ≥ 1 passo concluído ⇒ desbloqueado → varredura em série começando
pelo tip → coleta por SHA em `docs/evidence/post-billing-sweep-2026-09-2x/` com `checked === discovered`
→ decisão humana sobre manter/reverter o tiering pelo critério **re-centrado em 425 s** (banda 361–489 s,
corrigido de 322 s — que era derivado de modelo, não medido).

## 8. Plano (resumo)

T1 rearmar a sonda → T2 detectar desbloqueio → T3 `rerun` do light de `011c7e3` (único bloqueado 100 %
`docs/evidence/**`, com trabalho real) como primeiro sinal → T4 push único dos commits locais (com
aprovação) → T5 heavy do tip → T6 varredura dos demais, um por vez → T7 amostra B4 (5 primeiros pushes
não-docs: `event=push`, `head_ref=develop`, `mission/*` fora) → T8 relatório + decisão D3.

## 9. Riscos (resumo)

- **RISK-01 queimar cota sem produzir evidência** (o caso `L154`: um push de documentação na raiz do
  ledger disparou a heavy) ⇒ nada é pushado sem que se saiba o que o diff dispara.
- **RISK-02 auto-cancelamento** entre dois heavies da mesma ref ⇒ série, nunca paralelo.
- **RISK-03 ler ausência de run como falha** ⇒ `5539226` e commits vazios tratados à parte.
- **RISK-04 rerun de run `cancelled` contaminar a amostra** ⇒ filtro explícito (achado N2 do WP-R8).
- **RISK-05 decisão D3 tomada com o número errado** ⇒ usar o critério re-centrado em 425 s.

## 10. Traceabilidade

REQ-01…REQ-07 → T1…T8 → AC-01…AC-05.

## 11. Dependências e aprovações

- **Bloqueio humano:** pagamento / spending limit (Settings do GitHub). Nenhuma via de API.
- **Aprovação humana necessária:** o push (único, dos commits locais) e a decisão D3 (manter ou
  `git revert -m 1 4be813c`).
