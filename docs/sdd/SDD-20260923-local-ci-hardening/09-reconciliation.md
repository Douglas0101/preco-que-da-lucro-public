# 09 — Reconciliação · SDD-20260923-local-ci-hardening

> **Propósito:** confrontar o que a SPEC original (`01-spec.md`) propôs, o que o **escopo aprovado**
> (`APPROVE_ITEM_5=yes`) pediu, e o que foi **efetivamente implementado e medido**. Onde os três
> divergem, este documento diz — em vez de deixar a spec parecendo cumprida.

## 0. O achado central desta reconciliação

**A SPEC original e o escopo aprovado não são o mesmo conjunto de requisitos.**

- `01-spec.md` propôs **REQ-01…REQ-09** sobre **testar o próprio instrumento** (redaction, verificação
  estática, armadilhas de `set -e`, controle negativo de cobertura, tabela de escopo, idempotência de
  preservação, modo `--fast`, contradição de manifesto).
- O escopo **aprovado** do Item 5 foi **A–F**: ruído do secret-scan, contagens/`measuredAt`,
  `manifest.sha256` no selo, pré-condição de árvore suja, flake do e2e, inventário de worktrees.

Interseção: **apenas `REQ-09`** (contradição de manifesto ⇒ falha) e, parcialmente, `REQ-06`
(política de evidência testada). **Todo o resto da spec original segue aberto** — e agora está
nomeado abaixo, em vez de implicitamente "coberto" por o item ter sido executado.

O cabeçalho de `01-spec.md` dizia `Status: SPEC — aguardando aprovação (nada implementado neste ciclo)`.
Isso ficou **factualmente errado** quando o Item 5 foi aprovado e executado com outro escopo; o
cabeçalho foi corrigido nesta mesma passada (ver §4).

## 1. Requisitos originais (01-spec) × implementados

| REQ        | Original                                                                       | Implementado? | Delta                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **REQ-01** | redaction testada (caso injeta segredo e reprova se vazar)                     | **NÃO**       | `redact()` existe e funcionou em produção; **sem teste de regressão**. Aberto.                                                                                                                                                    |
| **REQ-02** | verificação estática (`bash -n`; `shellcheck` quando disponível)               | **NÃO**       | O ciclo rodou `bash -n` à mão a cada edição, mas **não** há etapa no instrumento. Aberto.                                                                                                                                         |
| **REQ-03** | ausência de armadilhas de `set -e`                                             | **NÃO**       | Verificação manual; sem verificador. Aberto.                                                                                                                                                                                      |
| **REQ-04** | cobertura por identidade **com controle negativo**                             | **NÃO**       | `coverage_check` asserta igualdade (segue valendo); o **controle negativo** não foi criado. Aberto.                                                                                                                               |
| **REQ-05** | tabela de casos para o escopo (`db=true/false`, base desconhecida fail-closed) | **NÃO**       | O escopo foi exercitado em produção (`db=true` e `db=skipped` medidos), mas sem teste de tabela. Aberto.                                                                                                                          |
| **REQ-06** | política de evidência testada (estende o controle negativo de `AC-05`)         | **PARCIAL**   | A política ganhou **asserção de gate** (cross-check de contagens, §3) que **falhou de verdade** uma vez; **não** virou teste unitário. Parcial.                                                                                   |
| **REQ-07** | preservação por idempotência (2ª rodada arquiva a 1ª)                          | **NÃO**       | O comportamento é real e foi observado (o arquivamento automático ocorreu 3× neste ciclo), sem teste. Aberto.                                                                                                                     |
| **REQ-08** | modo `--fast` seguro (skips nomeados, nunca `success`)                         | **NÃO**       | Não implementado — e o ciclo mostrou que **não** é a prioridade: o custo real é dominado por `test`/`build`/e2e, e um modo que pula verificação é exatamente o que o repo proíbe sem ADR. Recomendado **descartar** ou reescopar. |
| **REQ-09** | falha alta em contradição de manifesto                                         | **SIM**       | `verify_git_checksum` rebaixa o veredicto quando o selo e a contagem declarada divergem. Implementado em `caddf97`, causa raiz fechada em `1cf2bc3`.                                                                              |

**`checked === discovered` da spec original:** 9 declarados, **1 implementado**, 1 parcial, 7 abertos —
declarado, não maquiado.

## 2. Escopo aprovado (A–F) × implementado

| Frente | Pedido                                                    | Implementado | Evidência                                                                                     |
| ------ | --------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| **A**  | allowlist mínima/declarada/testada para o ruído           | **SIM**      | 5 entradas (todas usadas) + `scripts/local-ci-secret-scan.mjs`; **12 casos negativos**        |
| **B**  | `measuredAt` + contagens separadas + divergência falha    | **SIM**      | `countsAreSnapshotAt`, `filesIgnoredOther`, `treeState`; cross-check em `verify_git_checksum` |
| **C**  | `manifest.sha256` no selo versionável                     | **SIM**      | `grep -c` = 1; clone limpo 92/92                                                              |
| **D**  | pré-condição de árvore suja endurecida, escape registrado | **SIM**      | exit 2; `dirtyEscapeUsed` + `headShaCorrespondsToContent` + pendência nominal                 |
| **E**  | flake do e2e como limite conhecido + diagnóstico          | **SIM**      | `known-limitation`; trace/screenshot/vídeo/error-context preservados; **sem retry**           |
| **F**  | worktrees apenas inventariadas                            | **SIM**      | `_ops/artifacts/worktree-inventory.md`; **nenhuma remoção**                                   |

**Precisão de alvo que mudou a implementação:** o despacho pediu "ruído do **secret-audit**"; a medição
mostrou que os hits vêm do **`range-secret-scan` do `local-ci`** — o `m02:secrets-audit` tem 0 literais e
nenhum padrão de URL postgres. A allowlist foi aplicada no instrumento que produz o ruído.

## 3. Critérios de aceite

### 3.1 Os 14 do escopo aprovado — **14/14 medidos**

Rastreabilidade completa em `02-acceptance.md`; estado medido em `07-evidence.md`. Resumo: detecção
preservada (N1–N4), ruído zerado (`hits=0`), allowlist testada (12 casos), `measuredAt` declarado,
contagens com igualdade verificada (`92 = 93 − 1`), `manifest.sha256` no selo, recusa de árvore suja,
escape registrado, **nenhum gate tocado**, `local-ci` verde (341 s), clone limpo 92/92, journal, sem push.

### 3.2 Os 4 da spec original — **1 de 4**

| AC        | Original                                                 | Medido      | Delta                                                                                                                 |
| --------- | -------------------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------- |
| **AC-01** | casos de REQ-01/04/05 passam com controle negativo       | **NÃO**     | nenhum dos três REQ foi implementado                                                                                  |
| **AC-02** | suíte do instrumento roda em `npm run test`              | **PARCIAL** | a suíte criada (`local-ci-secret-scan.test.ts`) roda em `npm run test`; ela cobre a frente **A**, não os REQ-01/04/05 |
| **AC-03** | nenhuma etapa removida; `local-ci` verde no HEAD vigente | **SIM**     | 341 s, `verdict=success`, exit 0                                                                                      |
| **AC-04** | `checked === discovered` das propriedades da SPEC        | **NÃO**     | 7 REQ abertos — declarado em §1                                                                                       |

## 4. Defeitos encontrados durante a implementação

Todos os cinco foram **corrigidos**, nenhum mascarado. Quatro são **meus**.

| #      | Defeito                                                                    | Causa                                                                                                      | Correção                                                                                              | Teste/falsificabilidade                                                                          |
| ------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **D1** | `total=0` lido como "limpo" (**fail-open**)                                | padrão usava `\b` e `(?:...)`, que **POSIX ERE não suporta**; `git grep` casou zero linhas                 | padrão reescrito em ERE estrito **+ teste de vivacidade obrigatório** (5 probes; falha ⇒ precondição) | o próprio pipeline: precondição nomeada                                                          |
| **D2** | o instrumento carregava os literais que procura                            | probe de vivacidade com `ghp_…` **literal** em script commitado; `m02:secrets-audit` reprovou corretamente | probes e fixtures montados em runtime; autodeclaração isenta **por código**                           | **N11** (padrão duro na autodeclaração continua hit)                                             |
| **D3** | evidência selada com árvore suja (SHA não continha o conteúdo)             | rodada executada antes do commit                                                                           | precondição que **recusa** (exit 2) + `MISLABEL-DECLARADO.md` no arquivo                              | precondição testada contra a árvore suja real                                                    |
| **D4** | estado mudou **durante** a rodada                                          | arquivos do SDD escritos com o pipeline em execução                                                        | checagem de HEAD+sujeira **início × fim** no `finalize`, que rebaixa o veredicto                      | pendência nominal `state-drift`                                                                  |
| **D5** | veredicto `failure` com exit **0** e mensagem `success`                    | `finalize` rebaixava `RESULT`, mas a mensagem era fixa e o exit não seguia                                 | mensagem e exit code passam a refletir o veredicto real                                               | medido: exit 1 na rodada vermelha, 0 na verde                                                    |
| **D6** | cross-check de contagens reprovou o próprio selo (`cobre 91 × declara 91`) | `evidence-policy-final.status` escrito **depois** da última medição (a imprecisão **L1**)                  | status escrito **antes** da medição final, que virou a última escrita                                 | **controle negativo real**: a asserção disparou e está preservada em `evidence-git-checksum.log` |

## 5. O que mudou e por quê

1. **O alvo do hardening mudou por medição, não por opinião.** A spec supunha que o risco maior era a
   ausência de testes do instrumento; o escopo aprovado mirou **ruído e integridade da evidência** — e o
   ciclo provou que a segunda era mais urgente: **três** dos seis defeitos (D3, D4, D6) são de
   integridade de evidência, e nenhum seria pego pelos REQ-01…REQ-05 originais.
2. **A imprecisão L1 só foi corrigida quando virou falha de gate.** Ela passou um ciclo inteiro
   declarada como prosa ("as contagens valem em `measuredAt`"). O padrão generaliza: **declarar uma
   imprecisão não a corrige; transformá-la em asserção sim.**
3. **O instrumento passou a se auto-verificar em três eixos** que antes não existiam: vivacidade do
   detector, correspondência entre rótulo (`headSha`) e conteúdo, e igualdade entre contagem declarada e
   selo.
4. **Nenhum contrato de gate foi alterado** — verificado por commit, não por prosa (`06-traceability.md`).

## 6. Recomendações para os próximos ciclos

1. **Não reabrir o Item 5.** Ele está fechado no escopo aprovado. O que resta da spec original é um
   **backlog novo**, não um delta do Item 5.
2. **Priorizar, do backlog da spec original, apenas `REQ-01` (redaction testada) e `REQ-04` (controle
   negativo de cobertura).** São as duas únicas com histórico de defeito real: `REQ-01` porque o
   vazamento de segredo **aconteceu** (rodada 1) e hoje está corrigido **sem teste**; `REQ-04` porque a
   cobertura é o que impede uma etapa sumir em silêncio.
3. **Descartar `REQ-08` (`--fast`).** Um modo que pula verificação é a porta mais curta para verde
   falso, e o repo exige ADR para afrouxar orçamento. O custo real do pipeline (~5,7 min) é dominado por
   `test`/`build`/e2e — que são exatamente o que ele pularia.
4. **`REQ-02`/`REQ-03` (verificação estática) valem só se houver `shellcheck` no ambiente**; caso
   contrário, viram precondição declarada — e precondição que sempre falha não é gate.
5. **Tratar os dois achados do agente de observabilidade** como itens de higiene separados:
   **5 refs `origin/*` obsoletas** (um push delas recriaria branch deletada no remoto) e **9 tags
   `ci-local/*` locais** (um `git push --tags` publicaria todas). Ambos exigem decisão humana — remover
   ref/tag está fora da autonomia do agente.
6. **Manter o padrão que funcionou:** cada propriedade nova entra com **caso negativo antes** do
   encadeamento, e todo instrumento que emite veredicto tem um caminho para **falhar de verdade**
   (o D6 só foi corrigido porque a asserção disparou na primeira execução real).

## 7. Achados dos agentes de observabilidade (registrados, **não** corrigidos neste ciclo)

Os dois achados abaixo são **reais** e foram produzidos por verificação adversarial independente. Este
ciclo é de **documentação e reconciliação** — corrigi-los seria expandir escopo. Ficam nomeados com a
evidência e a correção recomendada.

### OBS-01 — `AL-03` da allowlist está **não ancorada** (risco latente, não exposição atual)

- **O que é:** a entrada `AL-03` tem `pattern: "postgresql://app_runtime:"`, escopo
  `.github/workflows/ui-stack.yml`. O padrão é um **prefixo**, não a forma benigna completa.
- **Prova (sonda sintética no classificador, sem mutar o repositório):** uma linha
  uma URL de banco com **usuario e senha literais e host real** (a sonda exata NAO e reproduzida aqui: uma cadeia com forma de credencial num documento versionado e exatamente o que o scanner deve reprovar, e reproduzi-la para "documentar" o achado seria criar o defeito que ele descreve) **nesse arquivo** é **suprimida**
  (`permitidos=1, hits=0, ids=AL-03:1`); a mesma linha **fora** do escopo é detectada (`hits=1`).
- **Por que não é exposição:** a única ocorrência atual (`ui-stack.yml:173`) é
  uma URL montada em **shell**, com a senha e o host vindo de **variáveis** (`runtime_password` e `db_host`), não de literais — não é segredo. Nada real está
  suprimido **hoje**.
- **Correção recomendada:** ancorar o padrão em `:${runtime_password}@${db_host}`, que é a forma
  benigna exata. Isso torna a supressão tão estreita quanto a razão declarada já afirma.
- **Classe:** endurecimento da allowlist (mesma família do Item 5, frente A) — cabe em ciclo próprio.

### OBS-02 — o `range-secret-scan` é **consultivo, não gate**

- **O que é:** `scripts/local-ci-secret-scan.mjs` classifica e **imprime**; quem transforma hits em
  estado é `local-ci.sh` (status `review`). **Nenhum consumidor converte `review` em falha** — o
  resultado é registrado no manifesto e a rodada segue.
- **Consequência:** um hit futuro **não** para o pipeline. A redução de ruído do Item 5 melhora a
  **legibilidade** do sinal, mas não o poder de **interdição**.
- **Por que não é defeito do Item 5:** o escopo aprovado foi "reduzir ruído sem reduzir detecção", e a
  detecção foi preservada e testada. Tornar o scan **bloqueante** é mudança de contrato de gate — exige
  **ADR**, e este ciclo não pode fazê-la.
- **Recomendação:** decidir explicitamente entre (a) manter consultivo e **declarar** isso no
  `AGENTS.md`, ou (b) promover a gate **com ADR**, aceitando que falsos positivos passem a bloquear
  trabalho. A decisão (a) é a mais barata e é a atual de fato — o problema é que ela está **implícita**.
- **Nota de honestidade:** hoje o efeito prático é nulo (0 hits), mas a diferença entre "consultivo" e
  "gate" é exatamente a diferença que o DBT-19 tratou no ciclo anterior — **cobertura aparente**.

### OBS-03 — o auditor do repo **exclui** `docs/evidence/`

- `m02:secrets-audit` declara em `limits` que exclui evidência, diretórios privados/vendor, testes e
  symlinks. Logo o verde dele **não cobre** logs nem selos de evidência.
- A lacuna foi fechada **à mão** na auditoria (varredura independente de 138 `*.log.txt` versionados e
  dos `.log` em `_archive/`): **zero** padrões duros e **zero** URLs com credencial.
- **Recomendação:** declarar esse limite no `AGENTS.md` junto da tabela de cobertura — hoje ele só
  aparece no campo `limits` do próprio JSON, que ninguém lê em revisão.

### OBS-04 — higiene de refs/tags locais (achado do agente de mutação remota)

- **5 refs `origin/*` obsoletas** (`chore/ci-path-filter`, `codex/evidence-2026-09-08`, `codex/p0-closeout`,
  `feat/p0-port`, `vercel/install-vercel-web-analytics-…`) existem localmente mas **não existem mais no
  remoto** — um push delas **recriaria branch deletada** no GitHub.
- **9 tags locais `ci-local/*`** sem correspondente remoto; um `git push --tags` publicaria todas.
- **Nenhuma das duas se materializa neste ciclo** (não há push), mas ambas são risco de um push futuro.
  Remover ref/tag está **fora da autonomia do agente** — exige decisão humana.
