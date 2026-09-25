# ADR-028 — Piso de Node `>=24.6.0` como transição (teto do hPanel)

- **ID:** ADR-028 · **Rastro:** F-1 (rodada de produção 2026-09-12) ← F-HP item 1 (`docs/evidence/hpanel-homologacao-2026-09-12/01-node-version.md`) · **Data:** 2026-09-12
- **Estado:** PROPOSTA / DRAFT — **nenhuma alteração de `package.json`, `package-lock.json` ou `.npmrc` foi feita nesta rodada**
- **Tipo:** contrato de toolchain + transição com prazo (exceção declarada, nunca silêncio)
- **Precedente de forma:** ADR-023 (major alvo + gate estrito): default do provedor ≠ contrato do produto

## 1. Fato

1. `package.json:7-9` declara `engines.node = ">=24.15.0"`; o mesmo valor está espelhado em `package-lock.json:76` (`packages[""]`).
2. `.nvmrc:1` fixa `24.15.0` (desenvolvimento e CI); os 4 workflows instalam com `node-version-file: .nvmrc` (`ui-stack.yml:40-42`, `neon-pr-branch.yml:81-83`, `neon-preview.yml:27-29`, `neon-readiness.yml:143-145`).
3. `.npmrc:1` tem `engine-strict=true` → `engines` incompatível é **erro fatal** (`EBADENGINE`) no install, não aviso. `.npmrc:2` mantém `package-lock=true`.
4. O runtime de build do Web App no hPanel tem **teto Node v24.6.0** (npm 11.5.1) e o painel só oferece seleção por **major** (18/20/22/24) — não há escolha de patch (`01-node-version.md:4,18`).
5. Primeiro build no alvo: **FAIL `EBADENGINE`** — `Required: {"node":">=24.15.0"}` × `Actual: node v24.6.0`; causa raiz o par `{engines, engine-strict}` do repo (`EXECUTION-STATE-PROGRAM.md:1370-1371`).
6. Workaround mínimo aplicado/planejado: env **não-secreta** `NPM_CONFIG_ENGINE_STRICT=false` no Web App (precedência npm: CLI > env > `.npmrc`), pendente da ação humana H-6 (`SESSION-LIMIT.md`).
7. Veredito do item 1 da homologação: **FAIL** registrado; a correção canônica (relaxar `engines`) ficou como **ADR pendente de ratificação** (`01-node-version.md:25`).

## 2. Checklist de reconciliação 24.6 → 24.15 (veredito do F-1)

Método (somente leitura, sem `npm`/`npx`/`tsx`): varredura estática do `package-lock.json` inteiro (758 entradas, 549 com `engines.node`) avaliando **cada range contra `24.6.0`** com validador próprio calibrado por casos-conhecidos (`>=6.9.0` ✓, `^22.22.2 || ^24.15.0 || >=26.0.0` ✗, `^20.19.0 || >=22.12.0` ✓, `*` ✓); e varredura de `src/`, `scripts/`, `e2e/`, `.github/` por APIs/flags de Node acima de 24.6.0.

Resultado: **existem exatamente 2 nós da árvore que excluem 24.6.0** — o `root` **declarado** e um **piso oculto em devDependency (`jsdom`)**. Nenhum uso de API acima do piso.

| #   | Fonte (arquivo:linha)                                                                                                           | Achado                                                                                                                                                | Exclui 24.6.0? | Veredito                                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------- |
| A1  | `package.json:7-9` · `package-lock.json:76`                                                                                     | `engines.node = ">=24.15.0"` (root)                                                                                                                   | **SIM**        | blocker declarado — alvo do relaxamento               |
| A2  | `package.json:130` · `package-lock.json:8677,8707`                                                                              | `jsdom@30.0.1` (dev) `engines.node = "^22.22.2 \|\| ^24.15.0 \|\| >=26.0.0"`                                                                          | **SIM**        | blocker **oculto** — sobrevive ao relaxamento do root |
| A3  | `package-lock.json` (outras 548 entradas com `engines.node`)                                                                    | maiores pisos de runtime: TanStack Start `>=22.12.0`, `undici >=22.19.0`, `kysely >=22.0.0`, `nitro ^20.19.0 \|\| >=22.12.0`                          | NÃO            | OK em 24.6.0                                          |
| A4  | `src/` · `scripts/` · `e2e/`                                                                                                    | sem `node:sqlite`, `fs.glob`, `--experimental-*`, `process.getBuiltinModule`, `Error.isError`, `Promise.try`, `Math.sumPrecise`, `Uint8Array.*Base64` | NÃO            | nenhum floor de API > 24.6.0                          |
| A5  | `check-hostinger-runtime.mjs` · `m02-lockfile-guard.mjs` · `env-guard.mjs`                                                      | nenhum gate lê versão de Node                                                                                                                         | NÃO            | nada a alterar em scripts                             |
| A6  | `.github/workflows/` (4 usos de `setup-node`)                                                                                   | `node-version-file: .nvmrc` → 24.15.0                                                                                                                 | NÃO            | CI permanece em 24.15                                 |
| A7  | `package.json:6`                                                                                                                | `packageManager: npm@11.14.1` (imposto só por corepack)                                                                                               | NÃO            | assimetria conhecida (alvo: npm 11.5.1)               |
| A8  | `README.md:25,78` · `hpanel-homologacao.md:7` · `a4-matriz-hipoteses.md:21` · `cutover-A4.md:265` · `hostinger-cloud-node.md:9` | documentam `Node >= 24.15` e "teto < 24.15 = ABORT geral"                                                                                             | NÃO (doc)      | emendar no PR de ratificação                          |
| A9  | `AGENTS.md`                                                                                                                     | não fixa versão de Node                                                                                                                               | NÃO            | sem alteração                                         |

### 2.1 Achado A2 — piso oculto do `jsdom` (não previsto)

- `jsdom@30.0.1` está em `devDependencies` (`package.json:130`, spec `^30.0.1`) e é `devOptional` no lock (`package-lock.json:8677`); é exigido por `vitest` (peer `jsdom: "*"`, `node_modules/vitest/package.json`) e usado por `vitest.config.ts:11` (`environment: "jsdom"`).
- `engines.node` de `30.0.0`/`30.0.1` = `^22.22.2 || ^24.15.0 || >=26.0.0` → **Node 24.6.0 não satisfaz**; com `engine-strict=true` isso é `EBADENGINE` fatal, exatamente como no root — comportamento **assumido e a confirmar** no §8.2 (S-TEC P2: o único `EBADENGINE` reproduzido é o do `root` declarado; `engine-strict` sobre nó `devOptional` não foi exercitado).
- Packument do registry no cache npm local (285 versões estáveis): a última linha que aceita 24.6.0 é **`jsdom@29.1.1`** (publicada 2026-04-30, `engines.node = "^20.19.0 || ^22.13.0 || >=24.0.0"`); a quebra para `^22.22.2 || ^24.15.0 || >=26.0.0` entra em `30.0.0` (2026-07-27).
- `vitest@4.1.11` aceita qualquer `jsdom` (peer `*`), então um pin `~29.1.1` **não cria conflito de peer** — mas exige `package-lock.json` sincronizado e `npm run test` verde no CI (24.15) antes do merge.

### 2.2 Veredito do checklist

- O piso > 24.6.0 **existe** (contraria a expectativa conservadora): é declarado no `root` e **também** presente em `jsdom` (dev).
- O **runtime e o build** são compatíveis com 24.6.0: nenhuma dependência de produção exige > 24.6.0 e nenhuma API > 24.6.0 é usada no código do repo.
- Portanto `engines: ">=24.6.0"` é tecnicamente sustentável, mas **não é suficiente sozinho**: com `engine-strict=true` e `jsdom@30.0.x` na árvore, o `npm ci` no alvo continuaria falhando (`EBADENGINE`) mesmo depois do relaxamento do root. A cláusula D3 abaixo é o que fecha essa lacuna.

## 3. Decisão (proposta)

**D1 — Relaxar o piso declarado, como TRANSIÇÃO.** `package.json` `engines.node` passa de `">=24.15.0"` para `">=24.6.0"` (mesmo spec espelhado em `package-lock.json` `packages[""]`), em **um único commit** com o lockfile sincronizado (AGENTS.md §Dependency discipline). Nada mais muda no contrato de build/start.

**D2 — O pin de desenvolvimento e CI não desce.** `.nvmrc` permanece `24.15.0` e os 4 workflows continuam instalando por `node-version-file: .nvmrc`. O novo piso declara o **mínimo tolerado no alvo**, não o ambiente de desenvolvimento; o CI continua provando 24.15.0.

**D3 — Cláusula de suficiência (obrigatória).** O relaxamento do root **não basta** (A2). O PR que aplicar D1 deve escolher explicitamente uma das duas vias:

- **(i) canônica (recomendada):** fixar `jsdom` em `~29.1.1` (última linha que aceita 24.6.0, §2.1) no mesmo PR, com lockfile sincronizado e `npm run check` verde em 24.15.0. Com isso `npm ci` passa no alvo **sem nenhuma variável de ambiente extra** e `.npmrc` permanece `engine-strict=true` para toda a árvore.
- **(ii) mínima/interina:** manter `jsdom@30.x` e usar `NPM_CONFIG_ENGINE_STRICT=false` no Web App — workaround **transitório**, removido assim que (i) ou o critério de saída (a) for cumprido.

**D4 — `engine-strict=false` NUNCA é estado final.** O override por env (ou, pior, editar `.npmrc`) é dívida declarada com prazo, não configuração de produção. Proibido alterar `.npmrc` para `engine-strict=false`: isso enfraqueceria o contrato para toda a árvore e para o CI, e é justamente o que o `.npmrc` existe para impedir.

**D5 — Sem extensão silenciosa.** Enquanto D1+D3 estiverem em vigor, qualquer dependência que suba o piso para > 24.6.0 (ex.: bump futuro de `jsdom`, `vite`, `nitro`) deve ser tratada como quebra do fallback e exige decisão registrada — não um `NPM_CONFIG_ENGINE_STRICT=false` adicional.

## 4. Critérios de saída e prazo

O fallback expira — é uma **janela**, não um novo normal.

- **(a) Seletor do painel oferecer Node ≥ 24.15** (ou ≥ o piso declarado no momento): reverter D1 (`engines.node` volta a `">=24.15.0"`, lockfile no mesmo commit), remover o override de env, registrar a evidência do `node --version` observado no alvo (item 1 do runbook) e reavaliar o pin de `jsdom` (que pode voltar para `^30`). A homologação item 1 deixa de ser exceção.
- **(b) Registro canônico de ratificação (RAT/ATR) + PR.** O PR de D1+D3 só é canônico com: (1) este ADR **RATIFICADO** (assinatura da seção 9); (2) `docs/evidence/engines-reconciliation-2026-09-12.md` com o checklist da seção 2; (3) emenda dos runbooks A8 (`hpanel-homologacao.md:7`, `a4-matriz-hipoteses.md:21`, `cutover-A4.md:265`, `hostinger-cloud-node.md:9`) e `README.md:25,78` para "Node ≥ 24.6.0 no alvo hPanel por ADR-028, ≥ 24.15.0 em dev/CI"; (4) merge em `develop` com os gates verdes.
- **Prazo:** **60 dias** a partir da ratificação (se ratificado em 2026-09-12 → revisão obrigatória até **2026-11-11**), ou até o primeiro corte `develop → main` após essa data, o que ocorrer primeiro. Na revisão, apenas duas saídas: (a) cumprida → reverter o fallback; (a) não cumprida → **renovar por ADR explícito** (novo ADR com nova evidência do alvo) ou **desqualificar o alvo** (item 1 volta a ABORT geral e a hospedagem é reavaliada). **Nunca** prorrogação tácita.

## 5. Consequências

**Positivas**

- O alvo deixa de ser bloqueado pelo gate de install; a homologação itens 2–11 fica alcançável.
- O contrato declarado volta a ser **honesto**: o que está escrito é o que instala; a exceção fica em ADR, não escondida em painel.
- `engine-strict=true` permanece intacto para toda a árvore (a via (i) preserva o mecanismo que pegou o problema).
- `.nvmrc`/CI continuam em 24.15.0 → o piso de qualidade local não cai.

**Negativas / riscos aceitos**

- Assimetria declarada × testada: o repo passa a **declarar** suporte a 24.6.0 mas **testa** em 24.15.0. Código que use API 24.7+ passaria no CI e quebraria no alvo. Mitigação obrigatória: rodar `npm ci && npm run build` em Node 24.6.0 (via `nvm`) antes de cada homologação/corte do alvo, ou job diferencial de CI em `24.6.0` (a ser proposto em PR próprio — não implementado por este ADR).
- Via (i): o pin de `jsdom` congela o emulador de DOM um major atrás; testes de a11y/DOM precisam de `npm run test` verde em 24.15 antes do merge e revalidação no próximo bump.
- O teto do alvo pode mudar silenciosamente (patch/minor novo da plataforma): re-medir `node --version` em **toda** execução do item 1 e registrar.
- `packageManager: npm@11.14.1` × npm 11.5.1 no alvo permanece como assimetria conhecida (A7): sem efeito no install/build, mas é drift de toolchain a monitorar.

## 6. Rollback

- **Rollback do fallback (volta ao estado atual do repo):** um commit único revertendo `engines.node` para `">=24.15.0"` em `package.json` + `package-lock.json`. O pin de `jsdom` (se aplicado) **não precisa** ser revertido — `jsdom@29.1.1` também aceita 24.15.0 (`^20.19.0 || ^22.13.0 || >=24.0.0`).
- **Efeito do rollback:** o build no alvo volta a `EBADENGINE` (item 1 volta a FAIL/ABORT) e a homologação permanece bloqueada até haver Node ≥ 24.15 no painel — por isso o rollback é a saída correta se o alvo for desqualificado.
- **Não afetado por rollback:** artefato `.output/`, migrações, banco, env vars de runtime e o processo em execução. Nenhum estado de dados; nenhuma URL/segredo envolvido.
- **Rollback do override:** remover `NPM_CONFIG_ENGINE_STRICT=false` do Web App é operação de painel (out-of-repo) — registrar em `docs/evidence/` no momento em que ocorrer (AGENTS.md §Deployment contract).

## 7. Alternativas consideradas

- **A. Status quo + só o override de env:** mantém o piso declarado "honesto" (`>=24.15.0`) e joga o contrato real para o painel — exatamente o _out-of-repo drift_ que AGENTS.md manda registrar. Rejeitada como estado final; aceitável só como interino (D3-ii).
- **B. Migrar o alvo para Node 22 (major disponível no painel):** exigiria descer o piso para `>=22.22.2` (o `jsdom@30` pede `^22.22.2` no ramo 22) e não há evidência do patch exato oferecido pela plataforma; downgrade amplo de toolchain sem medição. Rejeitada.
- **C. Relaxar para `">=24"`:** mais permissivo do que o medido — admitiria 24.0–24.5, versões que nunca foram exercitadas no alvo; `">=24.6.0"` codifica exatamente o teto observado. Rejeitada.
- **D. `engine-strict=false` no `.npmrc`:** enfraquece o contrato para CI e para todos os contribuidores; o `.npmrc` é o mecanismo que detectou a incompatibilidade. Rejeitada (e proibida por D4).
- **E. Publicar artefato pré-buildado (build fora do alvo):** deslocaria o problema, não o resolveria, e amplia a superfície de deploy; fica registrada como opção futura caso o teto do alvo não suba até o prazo (§4).

## 8. Verificação (como provar que a implementação está correta)

1. `git diff` do PR mostra `engines.node` alterado **em `package.json` e em `package-lock.json`** no mesmo commit (e, na via (i), `jsdom` com spec `~29.1.1` + resolução no lock).
2. `nvm use 24.6.0 && npm ci` com `.npmrc engine-strict=true` e **sem** `NPM_CONFIG_ENGINE_STRICT` → exit 0 (prova D1+D3-i).
3. `nvm use 24.15.0 && npm run check` verde (CI local, mesmo gate do `ui-stack.yml`).
4. Build no alvo sem `EBADENGINE`, com `node --version` registrado; app sobe e `/api/health/live` responde 200 (item 2 do runbook; `scripts/check-hostinger-runtime.mjs` cobre o equivalente local).
5. Evidência arquivada em `docs/evidence/` (checklist da seção 2 + log do build + versão do Node) e runbooks A8 emendados.
6. **Via (ii) do §4 (fallback mínimo, sem mudar `engines`):** a prova equivalente **não** é o item 2 — é o **log de build do alvo** com `NPM_CONFIG_ENGINE_STRICT=false` ativo e `node --version` registrado (`v24.6.0`), mais os probes do item 4. Registrar no pacote de evidência (S-TEC P2).

## 9. Ratificação

- Aprovador (humano): ____________________ · Data: ____________________
- Efeito: PROPOSTA → RATIFICADO; D1+D3 implementáveis no PR canônico; prazo de 60 dias começa na data acima.
- Sem assinatura: vale o **estado atual** (`engines >=24.15.0` + override de env como medida mínima), com este ADR permanecendo PROPOSTA.

## 10. Referências

- `docs/evidence/hpanel-homologacao-2026-09-12/01-node-version.md` (FAIL + workaround + ADR pendente) e `SESSION-LIMIT.md` (H-6).
- `EXECUTION-STATE-PROGRAM.md:1370-1371` (1º build FAIL `EBADENGINE`).
- `package.json:6-9,24,26,130,137` · `.nvmrc:1` · `.npmrc:1-2` · `package-lock.json:76,8677,8707` · `vitest.config.ts:11` · `node_modules/vitest/package.json` (peer `jsdom`).
- ADR-017 (branching), ADR-023 (major alvo com gate estrito), AGENTS.md §Dependency discipline e §Deployment contract.
- `docs/runbooks/hostinger-cloud-node.md:9` · `docs/runbooks/hpanel-homologacao.md:7` · `docs/runbooks/a4-matriz-hipoteses.md:21` · `docs/runbooks/cutover-A4.md:265` · `README.md:25,78`.

---

## Anexo A — Checklist de reconciliação (conteúdo de `docs/evidence/engines-reconciliation-2026-09-12.md`)

Base: seção 2. Reprodutibilidade (somente leitura, sem `npm`/`npx`):

- **Ranges:** varrer `package-lock.json` → `packages[*].engines.node` e avaliar cada um contra `24.6.0`; calibrar o validador com casos-conhecidos antes de confiar no resultado (seção 2). Universo: 758 entradas, 549 com `engines.node`.
- **APIs/flags:** grep em `src/`, `scripts/`, `e2e/` por `node:sqlite|DatabaseSync|fs\.glob|globSync|--experimental-|process\.getBuiltinModule|registerHooks|Error\.isError|Promise\.try|Uint8Array\.(from|to)Base64|Math\.sumPrecise|RegExp\.escape|Float16Array|navigator\.locks|navigator\.storage|using \(|Symbol\.dispose` → zero ocorrências.
- **Gates:** grep por `engines` em `scripts/`, `src/`, `e2e/`, `.github/` → zero ocorrências (nenhum gate valida versão de Node).
- **Workflows:** `.github/workflows/*.yml` → `node-version-file: .nvmrc` (`ui-stack.yml:40-42`, `neon-pr-branch.yml:81-83`, `neon-preview.yml:27-29`, `neon-readiness.yml:143-145`).
- **Veredito:** piso > 24.6.0 somente em `root` (`>=24.15.0`) e `jsdom@30.0.1` (dev, `^22.22.2 || ^24.15.0 || >=26.0.0`); nenhuma exigência de API > 24.6.0; runtime/build de produção compatíveis com 24.6.0; remedição em `nvm use 24.6.0 && npm ci` não executada nesta rodada (sem `npm`/`npx`) e obrigatória no PR canônico (§8.2).
