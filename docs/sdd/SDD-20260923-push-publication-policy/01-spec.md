# 01 — SPEC · SDD-20260923-push-publication-policy

- **ID:** `SDD-20260923-push-publication-policy`
- **Status:** `SPEC` — **aguardando aprovação humana** (política; nada executado)
- **Data:** 2026-09-23
- **Nota de estrutura:** spec-only por decisão de escopo (item 8 do backlog). Expande na promoção.

## 1. Problema

Existem **10 commits locais** em `develop` à frente de `origin/develop` (`a2f5ff6`), todos validados
apenas por CI local. Não existe hoje uma **política escrita** que responda:

1. O que exatamente é pushado, em que ordem e com qual evidência anexada?
2. O que **nunca** é pushado (bundle, patches, logs, evidência crua)?
3. Como o push interage com a **janela sem verificação** de 18 SHAs?
4. Quem aprova, e o que a aprovação cobre (um push? a série? a publicação)?
5. Qual o critério de **reversão** após o push?

Sem isso, o push vira ato ad-hoc — e o repo já tem dois registros de push sob bloqueio que **queimaram
cota sem produzir evidência** (`L153`, `L154`), um deles por um diff de documentação na **raiz do
ledger**, que fica **fora** do `paths-ignore` e portanto dispara a heavy.

## 2. Contexto

- **Disparo por caminho (medido):** heavy dispara em push para `main`/`develop` cujo diff **não** seja
  todo `docs/evidence/**`; um diff só-docs cai na light. `EXECUTION-STATE-PROGRAM.md` está na **raiz**,
  logo **não** é coberto pelo `paths-ignore`.
- **Custo:** heavy ≈ **9,7 min** de runner (8 runs verdes, 497–605 s); `concurrency` cancela run
  superseded da mesma ref — **exceto** `main`, que nunca é cancelada por push posterior.
- **Política de branches (`AGENTS.md`):** `develop` é o ramo de trabalho diário; `main` é o ramo de
  release e **só** recebe merge via PR `develop → main` com CI verde.
- **Proteção de branch formal está pendente** (exige GitHub Pro ou repositório público) — `ADR-017`.
- **Regra do repo:** nunca force-push, rebase ou amend em commit já publicado (histórico do Lovable),
  e nunca fazer `develop` ficar atrás da linha de release.

## 3. Objetivo

Transformar o push de um ato ad-hoc em um **procedimento auditável, com pré-condições verificáveis,
escopo declarado e critério de reversão**.

## 4. Não objetivos

- Não executar push algum neste ciclo (a própria política aguarda aprovação).
- Não tornar o repositório público (decisão separada e estratégica).
- Não criar mirror remoto.
- Não alterar proteção de branch (bloqueado por plano/visibilidade).

## 5. Requisitos

- **REQ-01 — pré-condições verificáveis antes do push.** `npm run check` verde no tip **ou** evidência
  `local-ci` com `verdict=success` **no SHA exato do tip**; árvore limpa fora da evidência; `m02:state:check`
  verde; `origin/main` inalterado desde a última verificação.
- **REQ-02 — escopo do push declarado por escrito antes de executar**, incluindo a **classificação do
  diff** (só-docs ⇒ light; misto/código ⇒ heavy) e o **custo projetado** em minutos de runner.
- **REQ-03 — unidade de aprovação.** A aprovação humana cobre um **push nomeado** (ref + range de SHAs),
  não "publicar o projeto". Push seguinte = nova aprovação.
- **REQ-04 — o que nunca é pushado:** `*.log`, bundle (`local-commits-*.bundle`), patches, `.env`,
  credenciais e qualquer artefato efêmero. A política de evidência é `metadata-only`
  (`SDD-20260923-evidence-policy`).
- **REQ-05 — interação com a janela.** O primeiro push pós-desbloqueio **é** o gatilho da varredura
  (`SDD-20260923-post-billing-sweep`, REQ-01); não se faz push novo antes de a janela estar caracterizada.
- **REQ-06 — ordem e não-empilhamento.** Enquanto o billing bloquear, **zero** pushes (custo sem
  evidência). Desbloqueado: um push, aguardar o run terminar e ser lido, só então o próximo.
- **REQ-07 — critério de reversão escrito antes do push.** Para `develop`: `git revert` do commit
  problemático (nunca reescrever). Para o tiering de CI: `git revert -m 1 4be813c` se o critério
  re-centrado (425 s; banda 361–489 s) for violado.
- **REQ-08 — `main` só por PR** com CI verde; e sempre que `main` avançar, **merge de volta em
  `develop`** imediatamente (regra do `AGENTS.md`).
- **REQ-09 — registro pós-push.** Journal (`✔`) com `run@sha` reais, custo medido e o que ficou pendente;
  selo citando `run@sha` **somente** se o run existir.

## 6. Critérios de aceite (a expandir)

- **AC-01** checklist de pré-condições (REQ-01) executável, com saída por item — não prosa.
- **AC-02** nenhum arquivo de REQ-04 presente no range pushado (verificação por path).
- **AC-03** `origin/develop` e `origin/main` inalterados em qualquer ciclo em que não houve aprovação.
- **AC-04** `checked === discovered` no selo pós-push: nº de SHAs pushados = nº de SHAs com `run@sha` ou
  com dispensa declarada.
- **AC-05** nenhum `run@sha` inventado; runs `failure` bloqueados por cota classificados como
  **precondição de ambiente**, não como veredito de código.

## 7. Design (resumo)

- **Documento de política + checklist executável** (não apenas prosa): os itens de REQ-01 viram comandos
  com saída verificável, avaliados **antes** do push.
- **Pré-voo de disparo:** dado o diff, classificar light/heavy e projetar custo — mata a classe de erro
  do `L154`.
- **Aprovação granular:** o pedido de aprovação nomeia ref, range, classificação e custo.
- **Pós-push:** leitura do run, classificação (verde / vermelho de código / precondição de ambiente),
  journal e selo.

## 8. Plano (resumo)

T1 escrever a política + checklist → T2 implementar o pré-voo de classificação de diff (script local,
sem rede) → T3 dry-run do checklist contra o estado atual (deve **reprovar** o push, porque o billing
bloqueia) → T4 submeter à aprovação humana → T5 (só após aprovação e desbloqueio) executar.

## 9. Riscos (resumo)

- **RISK-01 push sob bloqueio queima cota e não mede nada** ⇒ REQ-06 (zero pushes enquanto bloqueado).
- **RISK-02 diff de documentação na raiz disparar a heavy** (caso `L154`) ⇒ pré-voo obrigatório (REQ-02).
- **RISK-03 aprovação vaga ("pode publicar") ser lida como aprovação permanente** ⇒ REQ-03: aprovação por
  push nomeado.
- **RISK-04 `develop` ficar atrás de `main`** após um PR de release ⇒ REQ-08 (back-merge imediato).
- **RISK-05 reescrever história para "consertar" um push ruim** ⇒ proibido; reversão por `revert`.

## 10. Traceabilidade

REQ-01…REQ-09 → T1…T5 → AC-01…AC-05.

## 11. Dependências e aprovações

- **Aprovação humana necessária:** a própria política (este documento) e cada push nomeado.
- **Bloqueio externo:** desbloqueio de billing para que qualquer push produza evidência.
- **Relaciona-se com:** `ADR-017` (branching), `SDD-20260923-post-billing-sweep`,
  `SDD-20260923-evidence-policy`.
