# SDD — Próximos Passos Pós-Reconciliação

**ID:** `SDD-20260924-proximos-passos`
**Documento:** spec de encaminhamento — **não implementa nada**; cada item só executa via despacho
**Versão:** 1.0
**Data:** 2026-09-24
**Autor:** agente (ciclo de reconciliação) · **Aprovação:** pendente de MAESTRO (D1–D8, §0)
**Caminho no repo:** `docs/sdd/SDD-20260924-proximos-passos/SDD.md`

**Origens cruzadas:**

- Checkpoint do ciclo de reconciliação (2026-09-24) + resultado da verificação §E (todas as claims
  git-nível confirmadas; nenhum refutado)
- Ponte de rastreabilidade: `docs/evidence/reconciliacao-plano-mestre-2026-09-24.md` (commit `e72c3c4`)
  — ancestralidade `12c90a1` ⊂ `origin/develop`, `55cb550` ⊂ `origin/main` ⇒ **mesmo repositório do
  Plano Mestre**
- Análise externa independente: cruzamento checkpoint × plano (2026-09-24) — convergência com o §8 do
  checkpoint sobre `DBT-19`: duas fontes, mesma conclusão

> **Verificação na inclusão (2026-09-24).** As 13 claims factuais deste documento foram conferidas
> contra o repositório no momento do commit, uma a uma, e **todas conferem**: HEAD/ahead, remotos,
> tags, refs, gates, `DBT-19`/`DBT-23` no registry, `AGENTS.md`, erratas do `ADR-030`, `CREATE_TAG`,
> selo da rodada `1b54a89c`, delta da preservação e existência do artefato `csf`. **Duas correções
> foram feitas na inclusão**, declaradas: (a) o caminho do pedido de `DBT-19` em `REQ-NP-01-05` estava
> errado — o arquivo existente é
> `docs/sdd/SDD-20260923-boundary-guard-dbt19/MAESTRO-REQUEST-DBT-19-CLOSURE.md`, e seguir o caminho
> original criaria um **pedido duplicado**; (b) caracteres estranhos no campo de caminho do cabeçalho.

**Estado de origem (verificado, não inferido):**

| Campo               | Valor                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch / HEAD       | `develop` · `e72c3c4` · ahead **32**                                                                                                                                            |
| Remotos (intocados) | `origin/develop` `a2f5ff6` · `origin/main` `9724d2c`                                                                                                                            |
| Instrumento         | `m02:state:check` verde · guards verdes · nenhum push                                                                                                                           |
| Árvore              | limpa fora da evidência declarada                                                                                                                                               |
| Preservação         | `local-commits-e72c3c4.bundle` + **32 patches** + `README-INTERVALO.md` · **delta 0** (32 = 32)                                                                                 |
| Tags locais         | **11** `ci-local/*` (instrumento cria por padrão — `CREATE_TAG`, linha 52 do script)                                                                                            |
| Refs                | 7 refs remotas locais (das quais 5 classificadas obsoletas no ciclo anterior — remoção remota = decisão humana)                                                                 |
| Rodada histórica    | `1b54a89c` com selo integral conferindo (0 falhas) — declarada, não reescrita                                                                                                   |
| Gates               | cadeia `check` com **16** gates · `DBT-19` **ABERTA** (`DEBTS.md`, 1 ocorrência) · `DBT-23` **não registrada** em `DEBTS.md` (vive em pedido `docs/sdd/*/MAESTRO-REQUEST-*.md`) |
| `AGENTS.md`         | 0 ocorrências de "DBT-19 fechado" (overclaim corrigido) · `ADR-030` com 2 erratas                                                                                               |

**Políticas herdadas (inegociáveis neste spec):**

1. `metadata-only` — 0 log, 0 bundle, 0 patch versionados.
2. Nenhum push sem decisão humana; **nunca** `--tags`/`--all`.
3. Retry (CI/e2e) somente via ADR.
4. Veredicto decidido **antes** da geração de artefatos; invariante final `result.txt == manifest.result`.
5. Rodada histórica se **declara**, não se reescreve.
6. `DEBTS.md` e `QUEUE.md`: escritor = **MAESTRO**; agente produz pedido em
   `docs/sdd/*/MAESTRO-REQUEST-*.md`.
7. Vocabulário de selos (canônico, definido neste ciclo): **selo versionável** = `evidence.git.sha256` ·
   **selo integral** = `<sha>.sha256` · **campos de veredicto** = `result.txt` / `manifest.result`.
8. Todo documento novo **declara qual numeração usa**: P0 canônico V7 (§36 do Plano) × passos §40 do
   Plano × fila de despacho (`docs/TODO.md`). O mapa das três está na ponte.
9. Preservação regenerada no HEAD do fim do ciclo, com **intervalo coberto declarado** (nome do bundle +
   `README-INTERVALO.md`); delta declarado × gerado = 0.

**Numeração deste documento:** itens `NP-01…NP-08`; requisitos `REQ-NP-xx-yy`; decisões `D1…D8`.
Numeração local — não se confunde com as três numerações mapeadas na ponte (política 8).

---

## 0. Sumário de decisões (pauta MAESTRO)

| #      | Decisão                                                                                   | Item     | Bloqueia                                                   | Recomendação do agente                                                |
| ------ | ----------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| **D1** | Autorizar ciclo de código curto — duas metades da `DBT-19`                                | NP-01    | confiança em todos os gates; valoriza D2 e D6              | **aprovar como próximo ciclo único**                                  |
| **D2** | Investigação profunda do e2e flake (SDD própria já existe)                                | NP-02    | ressalva permanente sobre "CI verde"                       | decidir antes do próximo ciclo que dependa de e2e                     |
| **D3** | Revisar `DBT-23`, registrar em `DEBTS.md` e decidir fechamento                            | NP-03    | situação irregular: débito atuado sem registro no registry | registrar (aberta ou fechada) — não deixar sem status                 |
| **D4** | Ancorar `AL-03` · scan consultivo → gate?                                                 | NP-04a/b | falso-negativo do scan de segredos                         | ancorar já; promoção a gate só com política de falha definida         |
| **D5** | `CREATE_TAG` (linha 52): default-on vs cabeçalho opt-in                                   | NP-04c   | instrumento contradiz a própria documentação               | **D5b** (corrigir cabeçalho para default-on) — não muda comportamento |
| **D6** | Push dos 32 commits (precondição externa: cota; protocolo no `AGENTS.md`)                 | NP-06    | publicação do trabalho de setembro                         | após NP-01 verde, com checklist §NP-06                                |
| **D7** | Limpeza: worktrees · 5 refs obsoletas (remoto) · 11 tags `ci-local/*` (local)             | NP-04d   | higiene; risco de push acidental de tags                   | remoto = humano; local pode ser despacho                              |
| **D8** | Lado Plano: ampliar gate §41 (P0 #2/#9/#11/#17) · datas · registro dos ciclos de setembro | NP-05    | rastreabilidade Plano ↔ programa                           | enviar como `MAESTRO-REQUEST`; dono do Plano edita                    |

---

## 1. Sequência e dependências

```text
D1 ──> NP-01 (código: DBT-19) ──────────────┐
                                             ├──> D6/NP-06 (push develop → main)
D2 ──> NP-02 (decisão; investigação via SDD própria, só com gates pinados)
D3 ──> NP-03 (ato MAESTRO, independente)     │
D4/D5/D7 ──> NP-04 (higiene, independente)   │
D8 ──> NP-05 (lado Plano, independente)      │
NP-07: bloqueado pela plataforma (sem ação)  │
NP-08: contínuo (todos os ciclos) ───────────┘
```

- **NP-01 primeiro:** é o único defeito aberto que **desarma guardas em silêncio** (duas análises
  independentes convergiram). Enquanto ele não fechar, (a) qualquer investigação do flake pode ser
  confundida por deriva de gates, e (b) o push publica 32 commits sobre uma cadeia não pinada.
- **NP-02 não depende de NP-01 para ser decidido** (D2 é decisão), mas a **execução** da investigação
  rende mais com gates pinados.
- **NP-03/NP-04/NP-05** são independentes e podem ser despachados em lote.
- **NP-06 (push)** idealmente depois de NP-01 verde + preservação regenerada no HEAD a publicar.

---

## 2. NP-01 — Ciclo de código: as duas metades da `DBT-19` `[D1 · executor: agente-código · tamanho: curto]`

**Contexto verificado:** `DBT-19` ABERTA em `DEBTS.md` (1 ocorrência); condição de fechamento exige
asserção de teste que **não existe**; hoje **um gate pode ser removido dos 16 com tudo verde**; a tabela
do `AGENTS.md` não é confrontada com os YAMLs por teste. O overclaim de fechamento já foi corrigido
(`AGENTS.md` "encadeado" + erratas no `ADR-030`) — falta a substância.

**Escopo:** somente testes novos + fixture de lista esperada. Nenhuma alteração de contrato de gate
(`package.json`, workflows, matriz, `.gitignore`) além do estritamente necessário ao pin — e qualquer
necessidade deve ser **declarada antes** no despacho.

| REQ            | Requisito                                                                                                                                                                                                         | Critério de aceite                                                                                                          |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `REQ-NP-01-01` | **Asserção por teste — tabela × YAML:** teste que confronta a tabela de gates do `AGENTS.md` com os YAMLs de workflow, **bidirecional**                                                                           | falha se: linha da tabela sem YAML/job correspondente; YAML/job sem linha; nome divergente. Verde no estado atual (16 × 16) |
| `REQ-NP-01-02` | **Pin da cadeia `check`:** teste que pinha a **lista ordenada** dos 16 gates                                                                                                                                      | falha se: gate removido, renomeado, reordenado, ou adicionado sem atualização explícita do fixture versionado               |
| `REQ-NP-01-03` | **Controle negativo real** (precedente DBT-23 L1/L2): exercitar cada teste do REQ-01/02 sobre mutação induzida (remover 1 linha; remover 1 gate da cadeia)                                                        | disparo documentado na evidência da rodada; **sem resíduo** de mutação no repo ao final                                     |
| `REQ-NP-01-04` | **Declaração honesta de cobertura:** o que **não** tiver teste unitário (ex.: partes do instrumento local-ci) deve ser declarado no pedido, não omitido                                                           | seção "sem cobertura" presente e nominal                                                                                    |
| `REQ-NP-01-05` | **Pedido de fechamento:** atualizar o pedido existente `docs/sdd/SDD-20260923-boundary-guard-dbt19/MAESTRO-REQUEST-DBT-19-CLOSURE.md` com o resultado dos REQ-01..04; **não** escrever em `DEBTS.md` (política 6) | pedido atualizado; `DEBTS.md` sem diff do agente                                                                            |

**DoD:** REQ-01..05 atendidos · `state:check` e guards verdes no HEAD do ciclo · rodada local-ci com selo
integral + selo versionável + `result.txt == manifest.result` · preservação regenerada com delta 0 ·
journal + TODO atualizados.
**Evidência a declarar:** 1 rodada (controles negativos inclusos) · pedido atualizado · diff dos
testes/fixture.
**Não-metas:** não corrigir o flake (NP-02); não fechar `DBT-19` (ato MAESTRO após D1+revisão); não
alterar workflows/matriz.
**Fechamento de `DBT-19`:** decisão exclusiva de MAESTRO contra o pedido.

---

## 3. NP-02 — E2E flake: decisão e regime interino `[D2 · executor: MAESTRO decide; investigação tem SDD própria]`

**Contexto verificado:** SDD de investigação criada no ciclo anterior (6 arquivos, commit `417a41f`),
**sem implementação**; premissa do despacho corrigida por experimento controlado (a falha **não** depende
de `db:test`); retry proibido sem ADR. O Plano Mestre ancora §41/§42/§45 em "CI verde" com E2E no
pipeline (§12.5/§24/§26) — logo, flake vivo = todo "CI verde" carrega risco de falso veredicto.

| REQ            | Requisito                                                                                                                                                                                                                                                 |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQ-NP-02-01` | **Regime interino (independe de D2):** enquanto o flake estiver aberto, toda alegação de "CI verde" em journal/checkpoint/evidência vem com ressalva explícita (`flake e2e conhecido — ver SDD do flake`). Registrar a regra no journal (1 linha)         |
| `REQ-NP-02-02` | **Se D2 = investigar:** despacho referencia a SDD existente (não reescrever); investigação só inicia após NP-01 (gates pinados) para não confundir flake com deriva de gate; qualquer quarentena/retry proposto exige **ADR novo** antes de implementação |
| `REQ-NP-02-03` | **Se D2 = não investigar agora:** aceite de risco registrado em journal + entrada no TODO com o nome do risco ("CI verde com ressalva indefinida")                                                                                                        |

**Não-metas:** este NP **não** implementa correção nem retry; apenas decide o regime e amarra a execução
à SDD existente.

---

## 4. NP-03 — `DBT-23`: regularizar registro e decidir fechamento `[D3 · ato exclusivo MAESTRO]`

**Contexto verificado (achado do §E):** `DBT-23` tem **0 ocorrências em `DEBTS.md`** — a atualização
L1/L2 vive no documento de pedido (commit `d485a67`). Ou seja: há um débito **atuado sem registro no
registry**. O registro é ato de MAESTRO (política 6); o agente não pode sanar isso sozinho.

| REQ            | Requisito                                                                                                                                                                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `REQ-NP-03-01` | MAESTRO revisa o pedido atualizado: L1 (veredicto antes de artefatos) + L2 (invariante `result.txt == manifest.result`) + controle negativo real (bloco extraído do script; caso divergente dispara, consistentes não) + declaração honesta "não há teste unitário para L1/L2" |
| `REQ-NP-03-02` | Decisão trinária: **(a)** registrar em `DEBTS.md` e fechar; **(b)** registrar e manter aberta (com o que falta nomeado); **(c)** devolver com perguntas via journal                                                                                                            |
| `REQ-NP-03-03` | Se fechar: a condição é que L1/L2 permaneçam protegidos pelo cross-check pré-geração e pelo invariante final no instrumento — ambos já implementados (commits `21a2953`, `736e706`); citar esses commits na linha do registry                                                  |

**Evidência:** diff de `DEBTS.md` (escritor: MAESTRO) + linha de journal.

---

## 5. NP-04 — Higiene do instrumento e do workspace `[D4, D5, D7]`

**(a) `AL-03` não ancorada.** Risco: falso-negativo do scan de segredos (literal que escape pela borda da
regex).

- `REQ-NP-04-01`: ancorar `AL-03` (âncoras explícitas de início/fim) + controle negativo com literal
  conhecido que **deve** seguir sendo capturado e exemplo que **deve** seguir permitido. Não alargar a
  allowlist — só ancorar a entrada existente.

**(b) Scan consultivo → gate?** Hoje o scan roda e não reprova veredicto.

- `REQ-NP-04-02`: se D4 promover a gate, definir **política de falha** antes (reprova `result.txt`?
  declara e segue?) — sem política escrita, não promover. Precedente deste ciclo: 2 literais com forma de
  credencial pegos em documento do próprio agente, removidos sem alargar allowlist — o scan consultivo
  **funcionou**; a promoção é ganho marginal, não urgência.

**(c) `CREATE_TAG` (linha 52) — contradição código↔doc viva.** `CREATE_TAG="${LOCAL_CI_TAG:-1}"` cria
tags **por padrão**; o cabeçalho documenta como **opt-in**. O ciclo anterior corrigiu a descrição no TODO
(`0be938c`), não o script.

- `REQ-NP-04-03` (**D5a**): mudar default para `0` — alinha código ao cabeçalho, **muda comportamento do
  instrumento** (exige declaração no despacho + nota no journal); ou
- `REQ-NP-04-04` (**D5b**, recomendada): reescrever o cabeçalho para **default-on** documentado — alinha
  doc ao código, **zero mudança de comportamento**.
- Em ambos: manter a instrução operacional **nunca `--tags`/`--all`** até D7.

**(d) Limpeza (D7).**

- `REQ-NP-04-05`: inventário antes de qualquer remoção — worktrees ativas × órfãs; as 5 refs obsoletas
  (**remoção remota = ato humano**, com baseline de refs/mtimes/pushed_at conferido antes e depois); as
  11 tags `ci-local/*` (remoção **local** pode ser despacho; registrar lista exata no journal antes).

---

## 6. NP-05 — Lado Plano Mestre (documento do programa, não do agente) `[D8 · saída: MAESTRO-REQUEST]`

**Contexto verificado por data de git:** `PLANO_MESTRE` 2026-08-27 · `MAPA_CRUZADO` 2026-08-09 ·
`REALINHAMENTO` 2026-08-15 — enquanto o programa seguiu (evidências `ws-03…ws-07` de 01/09,
`release-readiness` de 03/09, ponte de reconciliação de 24/09). A defasagem é **confirmada**, não
inferida. O agente **não edita** o Plano sem despacho; este NP produz pedido.

| REQ            | Requisito (proposta ao dono do Plano)                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REQ-NP-05-01` | **Ampliar o gate §41** com condições explícitas para os P0 canônicos hoje não gateados: **#2** Result Type, **#9** unidades/conversão, **#11** taxonomia de erro, **#17 quota/budget IA** — para #17, exigir teste regressivo do fix `csf_58b444f152e35ba899b5381e` (`resource-exhaustion.ai-budget-race`, CWE-770). Argumento: o único fix com registro de execução no Plano está exatamente no item que o gate não cobre |
| `REQ-NP-05-02` | **Verificar se o teste regressivo do csf está entre os 16 gates** da cadeia `check` (o pin do NP-01 é o lugar natural para essa garantia); se não estiver, propor inclusão via MAESTRO                                                                                                                                                                                                                                     |
| `REQ-NP-05-03` | **Registro de execução novo** no Plano (ou adendo na ponte): ciclos de setembro, incluindo reconciliação 24/09 e este spec                                                                                                                                                                                                                                                                                                 |
| `REQ-NP-05-04` | **Convenção de data:** atualizar o campo "Data" do header ou adotar "último registro: AAAA-MM-DD" (o header diz 08/08 enquanto notas internas vão a 08/27)                                                                                                                                                                                                                                                                 |

---

## 7. NP-06 — Push / release `[D6 · ato humano · protocolo no AGENTS.md]`

**Precondição externa:** cota (declarada no `AGENTS.md`). **Estado:** 32 commits à frente de
`origin/develop`.

**Checklist pré-push (todo item verificável):**

1. NP-01 verde no HEAD a publicar (recomendado, não obrigatório — se D6 preceder D1, registrar no journal
   que se publica com `DBT-19` aberta).
2. `git rev-list --count origin/develop..HEAD` confere com a preservação regenerada **no HEAD exato do
   push** (delta 0, política 9).
3. `state:check` + guards verdes nesse HEAD.
4. Diff `origin/develop..HEAD` revisado (32 commits; nenhum segredo — scan roda).
5. **Nunca** `--tags`/`--all`; comando de push explícito por ref.
6. Baseline remoto registrado antes (`ls-remote`, `pushed_at`); conferência depois.
7. Journal pós-push com SHAs publicados e hora.
8. Fluxo develop → main só via `release-readiness` vigente (precedente PR #21/#22).

---

## 8. NP-07 — Bloqueados pela plataforma `[sem ação possível]`

- **Item 7 da fila de despacho** (`docs/TODO.md`, terceira numeração — ver ponte):
  `SDD-20260923-post-billing-sweep` — **bloqueado pela plataforma**. Ação: nenhuma. Reavaliar quando a
  plataforma normalizar. **Nenhuma alteração de billing** até lá (mantida).
- Registrar em cada journal de ciclo: "Item 7 segue bloqueado" — para a referência nunca mais ficar
  pendurada (defeito #2 deste ciclo, corrigido).

---

## 9. NP-08 — Regressão dos invariantes corrigidos (todo ciclo futuro) `[contínuo · sem decisão]`

Checklist mínimo por ciclo (candidato a virar asserção do próprio instrumento, **sem** alterar contrato
de gate):

| #   | Invariante                                                                                     | Origem                                    |
| --- | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Cross-check de contagens roda **antes** de manifesto/REPORT/selos                              | veto de evidência (ciclo 24/09)           |
| 2   | `result.txt == manifest.result` ao final                                                       | idem                                      |
| 3   | Preservação no HEAD final com intervalo declarado; delta 0                                     | off-by-one (achado externo #4)            |
| 4   | Vocabulário de 3 selos usado em qualquer documento que cite "selo"                             | ambiguidade (achado externo #15)          |
| 5   | Documento declara qual numeração usa (P0 V7 / §40 / fila TODO)                                 | "item 7" pendurado (achado externo #5)    |
| 6   | `DEBTS.md`/`QUEUE.md` sem diff de agente; pedidos via `MAESTRO-REQUEST-*`                      | registry sem arquivo (achado externo #16) |
| 7   | Rodadas históricas declaradas, nunca reescritas                                                | `1b54a89c`                                |
| 8   | Ponte `reconciliacao-plano-mestre-2026-09-24.md` atualizada se o Plano ou o programa avançarem | achado externo #8                         |

---

## 10. Riscos até decisão (registro interino)

| Risco                                                     | Mitigação atual                    | Residual                 | Fecha com        |
| --------------------------------------------------------- | ---------------------------------- | ------------------------ | ---------------- |
| Gate removido dos 16 em silêncio                          | nenhuma automática                 | **alto**                 | NP-01 (D1)       |
| "CI verde" falso por flake e2e                            | ressalva verbal; sem retry         | médio                    | NP-02 (D2)       |
| Segredo escapa por `AL-03` não ancorada                   | revisão manual dos hits do scan    | médio-baixo              | NP-04a (D4)      |
| Push acidental de 11 tags `ci-local/*`                    | instrução "nunca `--tags`/`--all`" | baixo (erro humano)      | NP-04c/d (D5/D7) |
| Instrumento contradiz própria documentação (`CREATE_TAG`) | descrição corrigida no TODO        | baixo                    | NP-04c (D5)      |
| Perda local de 32 commits não publicados                  | preservação delta 0 + checksums    | baixo                    | NP-06 (D6)       |
| `DBT-23` atuado sem registro no registry                  | pedido documentado                 | baixo-médio (governança) | NP-03 (D3)       |
| Plano desatualizado induz decisão errada                  | ponte de 24/09                     | baixo-médio              | NP-05 (D8)       |

---

## 11. Próximo ciclo recomendado (único)

**NP-01, curto, mediante D1.** Justificativa: (i) único defeito aberto que desarma guardas em silêncio;
(ii) duas análises independentes convergiram (checkpoint §8 × cruzamento externo, sem uma ter ver visto a
outra); (iii) é pré-requisito de valor para D2 (investigação sem deriva de gate) e D6 (publicar sobre
cadeia pinada); (iv) mesmo padrão de defeito que a dívida denuncia — fechar `DBT-19` demonstra que o
registry anda.

**Aceite deste documento:** sua inclusão no repo custa 1 commit `docs(sdd)` + 1 linha de journal +
atualização do TODO (fila). Nada mais. Nenhuma decisão D1–D8 é pré-consumida por esta inclusão.

---

## Anexo A — Mapa rápido de escritas (quem pode escrever o quê)

| Artefato                                                                         | Escritor                   | Leitor/consumidor          |
| -------------------------------------------------------------------------------- | -------------------------- | -------------------------- |
| `DEBTS.md` (registry de débitos, DBT-\*)                                         | MAESTRO                    | todos                      |
| `QUEUE.md`                                                                       | MAESTRO                    | todos                      |
| journal / ledger do programa                                                     | agente                     | MAESTRO, agentes paralelos |
| `docs/sdd/*/MAESTRO-REQUEST-*.md`                                                | agente                     | MAESTRO                    |
| `docs/TODO.md` (fila do despacho — terceira numeração)                           | despacho/MAESTRO           | agente                     |
| `AGENTS.md`, workflows, `package.json`, matriz, `.gitignore` (contratos de gate) | somente despacho explícito | todos                      |
| Plano Mestre / MAPA_CRUZADO / REALINHAMENTO                                      | dono do Plano (via D8)     | todos                      |
| Ponte `docs/evidence/reconciliacao-plano-mestre-2026-09-24.md`                   | agente (adendos datados)   | todos                      |

_Fim do documento — `SDD-20260924-proximos-passos` v1.0._
