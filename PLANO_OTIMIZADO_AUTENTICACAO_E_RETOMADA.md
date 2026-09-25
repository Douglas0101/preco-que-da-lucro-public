# PLANO_OTIMIZADO — Autenticação e Retomada SDD

**Data da autenticação:** 2026-08-28
**Branch alvo:** `program/v5-fechamento-sdd`
**HEAD autenticado antes deste artefato:** `233ad6c28f0f2f5a543524ee174efc39f5a6d62e`
**Classe da rodada:** autenticação documental local; nenhuma retomada operacional executada
**Resultado:** `AUTH_PASS_WITH_WARNINGS`

> Este documento materializa a fase documental do plano. Ele não fecha produto,
> não promove M-02, não sela o scan, não consome gates e não autoriza operações
> remotas. O próprio arquivo é um novo artefato de trabalho; seu hash deve ser
> calculado externamente ao conteúdo, para evitar circularidade.

## 1. Sumário executivo

Os artefatos da rodada `COMPLETED_WITH_POST_OP_FAILURES` foram localizados,
recalculados e reconciliados com o estado local atual. Os hashes esperados dos
artefatos do post-op coincidem com os arquivos em disco; `round.yaml` e
`handoff.yaml` são parseáveis; o branch e o HEAD observados coincidem com o
baseline informado. Essa parte está autenticada como `LOCAL-VERIFIED` ou
`COMMAND-OUTPUT` conforme a tabela abaixo.

As ressalvas que permanecem são operacionais, não ocultas:

- a última tentativa documentada do Browser in-app oficial retornou
  `Browser is not available: iab`; não há veredicto de produto nem snapshots;
- o scan oficial `8dfe96b9-03a5-4521-a840-bcbbbfb3abfe` continua `running` na
  fase `threat_model`, sem `reportAvailable`, sem artefato selado e com
  `in_scope_files.txt` vazio; `findingCount=0` não é `SCAN-CLEAN`;
- `npm run m02:matrix:check` e `npm run m02:boundaries` continuam com exit `1`;
  M-02 permanece `PENDING/DEFERRED-EXTRACTION`, sem geração de matriz e sem
  stubs;
- não houve consulta remota nesta fase; afirmações externas sobre Git, Docker,
  Nitro, PostgreSQL ou Better Auth ficam marcadas como `DOCS-NOT-AVAILABLE`
  quando não são cobertas pela documentação local;
- os três subagents read-only desta rodada foram encerrados após duas janelas
  bounded sem handoff final. O silêncio foi registrado como `ABSENT-HANDOFF` e
  não foi promovido a aprovação.

**Próxima ação objetiva:** em rodada operacional separada, confirmar runtime e
fixture locais, tentar novamente apenas o IAB oficial, continuar o scan
existente até obter escopo/report/selo auditáveis e revalidar M-02 sem gerar a
matriz. Até lá, não avançar para P8.

## 2. Baseline autenticado

| Item                     | Valor declarado                            | Valor observado                                                                         | Fonte/classe                                                         | Status                        |
| ------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------- |
| Branch                   | `program/v5-fechamento-sdd`                | igual                                                                                   | `git branch --show-current` / `LOCAL-VERIFIED`                       | consistente                   |
| HEAD                     | `233ad6c28f0f2f5a543524ee174efc39f5a6d62e` | igual                                                                                   | `git rev-parse HEAD` / `LOCAL-VERIFIED`                              | consistente                   |
| Tracking                 | `origin/program/v5-fechamento-sdd`         | `[ahead 18]`, sem fetch nesta rodada                                                    | `git status -sb` / `LOCAL-VERIFIED`; equivalência remota não provada | advertência                   |
| Worktree rastreado       | somente `EXECUTION-STATE-PROGRAM.md`       | ` M EXECUTION-STATE-PROGRAM.md`                                                         | `git status --porcelain=v1` / `LOCAL-VERIFIED`                       | consistente                   |
| Worktree não rastreado   | `.pi/` deliberado                          | `?? .pi/`                                                                               | `git status --porcelain=v1` / `LOCAL-VERIFIED`                       | consistente                   |
| Worktree após este plano | nenhum novo código                         | o novo plano foi criado por esta rodada e permanece sem commit                          | comando pós-escrita a executar no handoff                            | mudança documental autorizada |
| Higiene de diff          | sem erro                                   | `git diff --check`: exit `0`, sem saída                                                 | `COMMAND-OUTPUT`                                                     | PASS                          |
| Gates                    | nenhum consumido                           | `gates_consumed=[]`                                                                     | `handoff.yaml`, ledger / `LOCAL-EVIDENCE`                            | intactos                      |
| Remoto                   | intocado                                   | sem fetch, pull, push, PR, merge ou deploy                                              | handoff/ledger; não foi emitido comando remoto                       | consistente                   |
| Runtime atual            | encerrado após o post-op                   | nenhum runtime iniciado na autenticação desta rodada                                    | post-op report / `LOCAL-EVIDENCE`                                    | não iniciado agora            |
| Runtime histórico        | preview local saudável em `127.0.0.1:4173` | live/ready/root HTTP `200` antes da tentativa IAB anterior; PID depois encerrado        | post-op report / `REPORTED` autenticado pelo artefato                | histórico                     |
| IAB                      | bloqueado na última tentativa              | saída literal `Browser is not available: iab`, disponibilidade `[]`                     | `iab-report.md` / `LOCAL-EVIDENCE`                                   | BLOCKED histórico             |
| Scanner                  | scan oficial existente                     | `running=true`, fase `threat_model`, `reportAvailable=false`, `sealed` não estabelecido | contexto oficial Codex Security / `COMMAND-OUTPUT`                   | BLOCKED                       |
| M-02 state marker        | parent-pinned válido                       | `npm run m02:state:check`: exit `0`                                                     | comando local / `LOCAL-VERIFIED`                                     | PASS isolado                  |
| M-02 matrix              | pendente                                   | `npm run m02:matrix:check`: exit `1`; drift pede geração/revisão                        | comando local / `LOCAL-VERIFIED`                                     | PENDING                       |
| M-02 boundaries          | pendente                                   | `npm run m02:boundaries`: exit `1`; 13 ocorrências em 9 caminhos únicos                 | comando local / `LOCAL-VERIFIED`                                     | PENDING                       |
| Teardown                 | concluído na rodada operacional anterior   | socket `4173` livre; `docker compose down` concluído; volume preservado                 | post-op report / `REPORTED`                                          | histórico autenticado         |
| Product verdict          | não emitido                                | `NO-VERDICT`                                                                            | IAB report/handoff                                                   | correto                       |

### 2.1 Estado dos commits-alvo

O intervalo local `a311fac..233ad6c` contém exatamente os dois commits
posteriores ao scan anterior:

```text
fc2f322 docs(qa): record local browser navigation attempt
233ad6c docs(qa): correct post-scan evidence scope
```

As alterações efetivas em ambos os commits são documentais:

- `EXECUTION-STATE-PROGRAM.md`;
- `docs/evidence/browser-navigation-2026-08-28.md`.

Isso é uma classificação do diff local, não substitui a cobertura do scanner
oficial. O scan oficial deve continuar usando exatamente o range
`a311fac509cf9581f089263f933b8097792b09a9..233ad6c28f0f2f5a543524ee174efc39f5a6d62e`.

## 3. Índice de artefatos e hashes

Os hashes abaixo foram recalculados no checkout atual. Os cinco valores
fornecidos como expectativa para a rodada anterior coincidem. O manifesto não
lista o próprio hash e o ledger foi tratado como valor externo ao append que o
produziu; essa separação evita circularidade.

| Artefato            | Caminho                                                                        | Existe? | SHA-256 esperado                                                   | SHA-256 observado                                                  | Status            | Observação                           |
| ------------------- | ------------------------------------------------------------------------------ | ------: | ------------------------------------------------------------------ | ------------------------------------------------------------------ | ----------------- | ------------------------------------ |
| Round YAML          | `.pi/evidence/orchestrated-open-scopes-2026-08-28/round.yaml`                  |     sim | não informado no briefing                                          | `a0b1631b1b3032abbcfc713abb86e02447efa338d37dc4182c91e435d9a1cec6` | autenticado       | YAML parseável                       |
| Relatório da rodada | `.pi/evidence/orchestrated-open-scopes-2026-08-28/report.md`                   |     sim | não informado no briefing                                          | `0208b87bc7b521b23e7e6963f2645a8e2a3baf20acd633d6c45344835f074907` | autenticado       | relato dos seis OPENs                |
| Checklist remoto    | `.pi/evidence/orchestrated-open-scopes-2026-08-28/remote-sync-checklist.md`    |     sim | não informado no briefing                                          | `46e1216762e046c50a91f56b4b8c096981608653fc43ec19b7674f807038f7dc` | autenticado       | preparação, não operação             |
| Relatório IAB       | `.pi/evidence/orchestrated-open-scopes-2026-08-28/post-op/iab-report.md`       |     sim | `5fd6da4d5cc1f5f5cb72cd1d9ea62bd9750242312914f2cae8787d13e2fe3fff` | `5fd6da4d5cc1f5f5cb72cd1d9ea62bd9750242312914f2cae8787d13e2fe3fff` | `HASH_MATCH`      | IAB indisponível; sem QA manual      |
| Relatório post-op   | `.pi/evidence/orchestrated-open-scopes-2026-08-28/post-op/post-op-report.md`   |     sim | `404e34135fd0040ef1b2bcdceaa58d75d4d784acb79bcfb394074442348a00af` | `404e34135fd0040ef1b2bcdceaa58d75d4d784acb79bcfb394074442348a00af` | `HASH_MATCH`      | checklist pós-operatório             |
| Handoff YAML        | `.pi/evidence/orchestrated-open-scopes-2026-08-28/post-op/handoff.yaml`        |     sim | `b46a04b3055a749223f5fb83d675166f77a8127f684d40ed306a15e0ee7ed0e3` | `b46a04b3055a749223f5fb83d675166f77a8127f684d40ed306a15e0ee7ed0e3` | `HASH_MATCH`      | `COMPLETED_WITH_POST_OP_FAILURES`    |
| Manifesto SHA       | `.pi/evidence/orchestrated-open-scopes-2026-08-28/post-op/artifact-sha256.txt` |     sim | `4a36d6e439af102593108cf6f8eb6d1469d65f5e6ff50ea346724c80562428f1` | `4a36d6e439af102593108cf6f8eb6d1469d65f5e6ff50ea346724c80562428f1` | `HASH_MATCH`      | auto-validação com `sha256sum -c`    |
| Ledger              | `EXECUTION-STATE-PROGRAM.md`                                                   |     sim | `48cefd758e2c87061aa55488f94a65dc5c22f478c7c7e7fee00fb62d79cddb0a` | `48cefd758e2c87061aa55488f94a65dc5c22f478c7c7e7fee00fb62d79cddb0a` | `HASH_MATCH`      | hash corresponde ao estado pré-plano |
| Scan final          | não existe                                                                     |     não | N/A                                                                | N/A                                                                | `NOT_ESTABLISHED` | scan continua sem report/selo        |

Validação adicional executada:

```text
round.yaml: parse PASS
post-op/handoff.yaml: parse PASS
artifact-sha256.txt: todos os caminhos listados -> OK
```

Não há `HASH_MISMATCH` nos artefatos existentes. O novo plano, por ser criado
depois do manifesto anterior, não pode ser retroativamente incluído nele sem
alterar o manifesto histórico; seu hash deve ser registrado em um manifesto
posterior ou no handoff desta rodada.

## 4. Reconciliação dos relatos

### 4.1 Por que `COMPLETED_WITH_POST_OP_FAILURES` é correto

O relato anterior não é sucesso pleno. O runtime local subiu e foi encerrado
corretamente, o banco local foi desmontado sem remover o volume, o estado M-02
foi preservado e os gates/remoto ficaram intactos. Porém, três critérios
materiais do post-op falharam: não houve snapshots IAB, o arquivo de escopo do
scan estava vazio e o scan não estava selado. Portanto a classificação
`COMPLETED_WITH_POST_OP_FAILURES` descreve execução parcial com falhas de
fechamento; não deve ser promovida para `COMPLETED`.

### 4.2 Nuance temporal do IAB

Há dois eventos históricos diferentes nos artefatos:

1. No relatório inicial, o IAB oficial foi selecionado, mas a aba para
   `http://127.0.0.1:4173/` recebeu `net::ERR_CONNECTION_REFUSED`; o runtime
   não estava acessível naquele instante.
2. Na tentativa posterior do post-op, o runtime local foi comprovado saudável,
   mas a seleção do IAB falhou com `Browser is not available: iab` e a lista de
   disponibilidade foi `[]`.

Os eventos não autorizam um veredicto positivo por combinação. A primeira
tentativa prova falha de conectividade do app naquela sessão; a segunda prova
indisponibilidade da superfície IAB. Na autenticação desta rodada não foi
iniciado browser, portanto a disponibilidade atual é `NOT-VERIFIED`, não uma
inferência de que o bloqueio histórico persiste.

### 4.3 Por que OPEN-01 e OPEN-04 continuam bloqueados

`OPEN-01` exige jornada visual no IAB oficial e `OPEN-04` depende dessa jornada
para as rotas `/produtos`, `/precos` e `/ponto-equilibrio`. A última execução
não alcançou login, navegação ou snapshot. A suíte Playwright automatizada e o
runtime histórico não substituem a cobertura manual exigida. Logo, os dois
escopos permanecem `BLOCKED`, sem `product verdict`.

O skill oficial também proíbe inspecionar cookies, localStorage, sessionStorage,
perfis, senhas ou stores do browser. A solicitação original de dump de storage
é incompatível com essa restrição autoritativa e deve permanecer não executada;
nenhum dump redigido deve ser criado como contorno.

### 4.4 Por que OPEN-03 continua bloqueado

O contexto oficial do Codex Security foi reconsultado sem iniciar outro scan:

```text
scanId: 8dfe96b9-03a5-4521-a840-bcbbbfb3abfe
range: a311fac509cf9581f089263f933b8097792b09a9..233ad6c28f0f2f5a543524ee174efc39f5a6d62e
status: running
phase: threat_model
filesTotal: 292
closedRows: 0
worklistRows: 0
findingCount: 0
reportAvailable: false
artifacts: {}
```

O diretório oficial observado contém `in_scope_files.txt` com zero bytes. Um
contador de findings igual a zero nesse estado significa que nenhum finding foi
emitido pelo fluxo ainda incompleto; não significa que os arquivos foram
revisados e considerados limpos. A regra de pronto exige `running=false`,
`sealed=true`, escopo não vazio, report auditável e cobertura completa do range.

O plano de retomada deve continuar este `scanId`, sem cancelar ou criar um scan
paralelo enquanto houver possibilidade de recuperação. Se, após recuperação
documentada e uma janela bounded, o serviço continuar sem produzir cobertura,
classificar como `BLOCKED-TOOLING`, preservar o estado e pedir intervenção — sem
declarar `SCAN-CLEAN`.

### 4.5 Por que OPEN-02 não está resolvido

O marker parent-pinned passou (`m02:state:check`, exit `0`), mas isso é apenas a
integridade do marker. Os validadores de conteúdo continuam falhando:

```text
npm run m02:matrix:check -> exit 1
M-02 matrix drift: execute npm run m02:matrix:generate and review the result.

npm run m02:boundaries -> exit 1
13 ocorrências em 9 caminhos únicos ausentes.
```

Os nove caminhos únicos permanecem classificados para planejamento como
`DEFERRED-EXTRACTION`; isso não prova que a implementação já existe, não é
waiver, não é allowlist e não resolve o catálogo. `npm run m02:matrix:generate`
não foi executado, nenhum stub foi criado e nenhum catálogo foi alterado.

### 4.6 Por que OPEN-05 e OPEN-06 podem permanecer PASS

`OPEN-05` trata da regularização da evidência de subagents. Os agentes R1/R2
históricos e os agentes read-only desta rodada não produziram handoff final;
essa ausência foi registrada, e comentários parciais não foram usados como
aprovação. O objetivo da auditoria foi atingido sem inventar evidência.

`OPEN-06` trata apenas da preparação da futura sincronização. O checklist existe
e a observação `[ahead 18]` foi registrada como tracking local sem fetch. Como
nenhum remoto foi tocado, o escopo de preparação pode ser `PASS` sem afirmar
equivalência remota.

## 5. Matriz de documentação oficial e de repositório

Não houve consulta à internet ou a serviços externos nesta fase. Por isso, as
fontes vendorizadas que não estão no checkout são explicitamente marcadas como
`DOCS-NOT-AVAILABLE`. As regras do IAB e do scanner foram autenticadas por
skills oficiais instaladas no ambiente Codex e pelo contexto oficial do scan.

| Tema                | Fonte                                                                                                                                                           | Versão/seção                                                  | Afirmação suportada                                                                                                                                                                                                      | Status                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| IAB oficial         | [`control-in-app-browser/SKILL.md`](file:///home/douglas-souza/.codex/plugins/cache/openai-bundled/browser/26.820.60940/skills/control-in-app-browser/SKILL.md) | regras de seleção e segurança, especialmente linhas 50–79     | usar `get("iab")`; se indisponível, reportar indisponibilidade; não usar `getDefault`, `getForUrl`, Chrome ou fallback; não inspecionar storage/perfis                                                                   | `OFFICIAL-DOC`                                                |
| Security diff scan  | [`security-diff-scan/SKILL.md`](file:///home/douglas-souza/.codex/plugins/cache/openai-curated-remote/codex-security/0.1.22/skills/security-diff-scan/SKILL.md) | linhas 12–39                                                  | manter range; continuar `scanId`; não substituir scan; finalizar só com cobertura e artefatos; não cancelar/falhar automaticamente                                                                                       | `OFFICIAL-DOC`                                                |
| Git local           | [`AGENTS.md`](AGENTS.md) e comandos `git` desta rodada                                                                                                          | instruções de branching; não houve doc externo                | o checkout local pode mostrar tracking/ahead; sem fetch não há equivalência remota autenticada                                                                                                                           | `REPO-DOC` + `COMMAND-OUTPUT`; doc Git externo não consultado |
| Docker Compose      | [`docs/runbooks/postgres-local-docker.md`](docs/runbooks/postgres-local-docker.md) e [`docker-compose.yml`](docker-compose.yml)                                 | linhas 10–16 e definição de volume                            | `db:down` desmonta o serviço preservando o volume nomeado; remoção de volume é uma operação distinta e proibida nesta retomada                                                                                           | `REPO-DOC`; doc Docker externo não consultado                 |
| npm/Node            | [`package.json`](package.json)                                                                                                                                  | scripts `build`, `preview`, `db:up`, `db:down`, `e2e:prepare` | scripts disponíveis e comandos locais do projeto; versões observadas: Node `v24.15.0`, npm `11.14.1`                                                                                                                     | `REPO-DOC` + `COMMAND-OUTPUT`; doc externo não consultado     |
| Nitro/preview       | [`playwright.config.ts`](playwright.config.ts)                                                                                                                  | linhas 3 e 25–28                                              | base URL `127.0.0.1:4173`; preview usa build, seed e `--host 127.0.0.1 --port 4173`                                                                                                                                      | `REPO-DOC`; documentação Nitro externa não consultada         |
| PostgreSQL local    | [`docs/runbooks/postgres-local-docker.md`](docs/runbooks/postgres-local-docker.md)                                                                              | linhas 1–37                                                   | imagem local `postgres:17-alpine`, URL local, seed e preservação do volume                                                                                                                                               | `REPO-DOC`; documentação PostgreSQL externa não consultada    |
| Better Auth fixture | [`scripts/e2e/seed-auth.ts`](scripts/e2e/seed-auth.ts) e [`src/server/auth/auth-policy.ts`](src/server/auth/auth-policy.ts)                                     | seed owner/member; origens locais e secret mínimo             | fixture local exige credenciais efêmeras e origens loopback; nenhum segredo é reproduzido                                                                                                                                | `REPO-DOC`; documentação Better Auth externa não consultada   |
| YAML/JSON           | pacote local `yaml` e comando de parse                                                                                                                          | validação realizada nos dois YAMLs                            | os documentos YAML foram parseados localmente; isso não valida semântica de produto                                                                                                                                      | `COMMAND-OUTPUT`; doc externa não consultada                  |
| Plugin management   | [`plugin-management/SKILL.md`](file:///home/douglas-souza/.codex/plugins/cache/openai-curated-remote/plugin-management/0.1.0/skills/plugin-management/SKILL.md) | instruções de descoberta/instalação                           | não instalar plugin quando a capacidade já está disponível; os nomes `local-server-manager`, `iab-controller`, `security-scanner` e `ledger-scribe` são papéis operacionais no handoff, não plugins instalados inferidos | `OFFICIAL-DOC`                                                |

O uso de links `file:///` acima é apenas referência local ao skill instalado; não
constitui consulta remota. No próximo handoff, se uma afirmação depender de uma
especificação externa, ela deve ficar `NOT-VERIFIED` até que a fonte autorizada
seja realmente acessada.

## 6. Plano otimizado da próxima execução

Esta seção é um runbook futuro. Nenhum dos comandos operacionais abaixo foi
executado na rodada de autenticação que produziu este documento.

### Fase 0 — Autenticação prévia (read-only)

Executar no checkout principal, antes de iniciar qualquer serviço:

```text
git rev-parse HEAD
git branch --show-current
git status -sb
git status --porcelain=v1
git diff --check
npm run m02:state:check
```

Critérios:

- HEAD diferente do esperado deve ser registrado como `HEAD-DRIFT`, sem
  rebase/reset automático;
- `[ahead N]` continua sendo apenas tracking local até uma autorização separada
  para `git fetch`;
- alterações devem ficar restritas ao ledger, `.pi/` e artefatos documentais
  autorizados;
- nenhum gate é consumido nesta fase.

### Fase 1 — Runtime local e fixture

Executar somente em ambiente local e descartável:

1. `npm run db:up` e aguardar o healthcheck do Compose.
2. Preparar a fixture com `npm run e2e:prepare`, usando owner/member
   sintéticos e credenciais efêmeras fora dos logs.
3. Executar `npm run build`.
4. Iniciar o preview com bind explícito em loopback:
   `npm run preview -- --host 127.0.0.1 --port 4173`.
5. Validar, antes de abrir o IAB:
   - `GET /api/health/live` → `200`;
   - `GET /api/health/ready` → `200`;
   - `GET /` → `200`.

O processo não deve herdar endpoints Neon por acidente. As URLs de banco devem
apontar explicitamente para `127.0.0.1:5432` e o valor do secret local não deve
aparecer em relatório. Se build, banco, fixture, porta ou healthcheck falhar,
abortar `OPEN-01/04` com a classificação específica (`RUNTIME-BOOT-FAILURE` ou
`CONFIGURATION-MISSING`) e não tentar browser alternativo.

Evidência mínima: comando, PID, bind, três respostas HTTP, timestamps e log
sanitizado do processo.

### Fase 2 — Inicialização do IAB oficial

Só depois dos healthchecks:

1. Ler/aplicar o skill oficial do Browser in-app.
2. Inicializar o runtime oficial do browser.
3. Obter exclusivamente `agent.browsers.get("iab")`.
4. Se o retorno for `Browser is not available: iab` ou a disponibilidade for
   vazia, registrar a saída literal e abortar `OPEN-01/04`.
5. Não chamar `getDefault()`, `getForUrl()`, `get("extension")`, Chrome,
   Docker Browser, Playwright headed externo, Kimi ou qualquer fallback.

O pedido anterior de inspecionar cookies, localStorage, sessionStorage e stores
fica revogado pela restrição do skill oficial: esses dados não devem ser
inspecionados nem exportados. O próximo handoff deve registrar
`storage_inspection: NOT_PERMITTED_BY_IAB_SKILL`, não fabricar um dump redigido.

### Fase 3 — QA manual das rotas pendentes

Executar somente se a Fase 2 entregar uma sessão IAB utilizável:

1. Login visual com a fixture owner/member.
2. Capturar snapshot oficial da página inicial e do shell autenticado.
3. Visitar `/produtos`, `/precos` e `/ponto-equilibrio`.
4. Para cada rota, registrar renderização, autorização, estado vazio/erro
   esperado, console sem erros inesperados e comportamento desktop/mobile.
5. Criar uma única despesa sentinela na fixture, confirmar sua presença e
   removê-la no mesmo escopo local.
6. Abrir o diálogo de reset e cancelá-lo; comprovar ausência de mutação por
   estado visível ou consulta de aplicação autorizada, sem acessar storage
   interno do browser.
7. Capturar snapshots, traces/equivalentes oficiais, console e requisições
   relevantes sem incluir tokens, cookies ou segredos.

O resultado só pode ser `PASS` se as três rotas e a jornada completa tiverem
evidência endereçável. Caso contrário, usar `BLOCKED` (IAB/infra) ou `FAIL`
(comportamento incorreto), sem produto aprovado por cobertura parcial.

### Fase 4 — Scan oficial integral e selado

O próximo agente de segurança deve continuar o scan existente:

- `scanId`: `8dfe96b9-03a5-4521-a840-bcbbbfb3abfe`;
- range imutável:
  `a311fac509cf9581f089263f933b8097792b09a9..233ad6c28f0f2f5a543524ee174efc39f5a6d62e`;
- escopo: somente os arquivos efetivamente alterados nesse intervalo;
- sem scan paralelo, sem troca de base/head e sem expansão para working tree.

Critério obrigatório de conclusão:

```yaml
scan:
  running: false
  sealed: true
  in_scope_files_populated: true
  report_available: true
  findings_accounted_for: true
```

O `in_scope_files.txt` deve conter os caminhos alterados, e o report/manifesto
deve possuir digest verificável. Se o scan continuar sem progresso, preservar o
scan e classificar `BLOCKED-TOOLING`; não cancelar sem solicitação explícita e
não transformar `findingCount=0` em limpeza.

### Fase 5 — M-02 sem mascaramento

Executar somente:

```text
npm run m02:matrix:check
npm run m02:boundaries
```

Não executar `npm run m02:matrix:generate`, não criar stubs, não alterar
catálogo e não converter ausências em waiver/allowlist sem decisão arquitetural.
Registrar o número e os caminhos das violações; manter a classificação
`DEFERRED-EXTRACTION/PENDING` até a onda autorizada de M-02.

### Fase 6 — Teardown local

Após o IAB, mesmo se a jornada falhar:

1. Encerrar o PID do preview com término gracioso; só usar escalonamento se o
   processo não terminar e registrar o motivo.
2. Executar `npm run db:down`/`docker compose down` sem `-v`.
3. Confirmar porta `4173` livre.
4. Confirmar que não há container/rede de Compose ativo.
5. Confirmar que o volume PostgreSQL nomeado continua presente.

É proibido executar `docker volume rm`, limpar dados persistentes, apagar
logs/evidências ou usar `down -v`.

### Fase 7 — Revisão pós-operatória

O auditor deve confirmar, antes do handoff:

- runtime saudável antes do IAB;
- IAB oficial disponível e sem fallback;
- snapshots das três rotas;
- CRUD da sentinela revertido;
- cancelamento do reset sem mutação;
- `in_scope_files.txt` não vazio;
- scan `sealed=true`, `running=false`, report presente;
- M-02 sem geração, stubs ou drift mascarado;
- gates `[]` e remoto intocado;
- worktree dentro da allowlist;
- hashes recalculados, com o hash do plano mantido fora do próprio conteúdo;
- ledger atualizado apenas por append autorizado e sem reescrever histórico.

## 7. Critérios de pronto

Uma futura rodada operacional só pode ser `COMPLETED` quando todos os itens
abaixo forem verdadeiros:

```yaml
ready:
  OPEN-01: PASS
  OPEN-03: PASS
  OPEN-04: PASS
  iab_snapshots: true
  security_scan:
    running: false
    sealed: true
    in_scope_files_populated: true
    report_available: true
  m02:
    status: PENDING_VISIBLE
    matrix_generate_executed: false
    stubs_created: false
  gates_consumed: []
  remote_touched: false
  post_op_audit: PASS
```

`OPEN-02` pode ter análise concluída, mas não pode ser apresentado como M-02
resolvido. A ausência de IAB ou de scan selado impõe `BLOCKED`/`COMPLETED_WITH_POST_OP_FAILURES`;
nunca `PASS` por inferência.

## 8. Critérios de bloqueio e abort

Classificar a execução como `BLOCKED` ou abortar o escopo correspondente se
ocorrer qualquer um dos casos:

- IAB ausente, indisponível ou substituído por fallback;
- runtime, banco, fixture, build, porta ou healthcheck indisponível;
- scan `running`, `sealed=false`, escopo vazio ou report ausente;
- hash divergente sem correção explícita e registrada;
- HEAD diferente sem autorização;
- worktree com código/configuração/schema/migration fora da allowlist;
- documentação crítica não disponível para uma afirmação que não possa ser
  sustentada pelo repositório;
- tentativa de fetch, push, PR, merge, deploy ou acesso externo;
- tentativa de consumir qualquer gate;
- tentativa de gerar a matriz M-02 ou criar stubs para silenciar validator;
- segredo, token ou dado sensível encontrado em evidência.

## 9. Matriz de riscos

| Risco                                     | Impacto                                                |               Probabilidade | Mitigação                                                                                  | Estado      |
| ----------------------------------------- | ------------------------------------------------------ | --------------------------: | ------------------------------------------------------------------------------------------ | ----------- |
| IAB indisponível                          | bloqueia QA manual e rotas pendentes                   | alta, dado o último retorno | healthcheck antes; `get("iab")` exclusivo; abort honesto                                   | aberto      |
| Runtime herda Neon por ambiente           | risco de tocar sistema externo ou contaminar evidência |                       média | env explícito loopback; validar host antes de iniciar                                      | controlável |
| Scanner não sela                          | bloqueia P8 e não permite `SCAN-CLEAN`                 |          alta, estado atual | continuar scanId; escopo explícito; preservar e bloquear se sem progresso                  | aberto      |
| Escopo vazio no scan                      | falsa sensação de zero findings                        |          alta, estado atual | exigir lista populada e cruzar com `git diff --name-only`                                  | aberto      |
| Tracking remoto sem fetch                 | ahead incorreto ou divergência oculta                  |                       média | registrar como tracking local; pedir autorização separada para fetch                       | aberto      |
| M-02 mascarado acidentalmente             | perda de integridade arquitetural                      |                       média | checks somente; proibidos generate/stubs/catalog edits                                     | controlado  |
| Volume local contamina fixture            | QA não determinística                                  |                       média | seed determinístico; teardown sem apagar volume; documentar estado                         | controlável |
| Evidência parcial promovida               | aprovação falsa de produto/segurança                   |                       média | classes de evidência; handoff obrigatório; post-op independente                            | controlado  |
| Handoff ausente de subagent               | ausência de revisão transferível                       |           alta nesta rodada | registrar `ABSENT-HANDOFF`; não usar comentários parciais; novo agente com timeout bounded | aberto      |
| Alteração do ledger quebra hash histórico | perda de auditabilidade                                |                       média | append-only; manifesto posterior; nunca sobrescrever hash antigo                           | controlado  |

## 10. Handoff recomendado para a próxima rodada

```yaml
next_round_type: operational-resume-with-local-gates
baseline:
  branch: program/v5-fechamento-sdd
  expected_head: 233ad6c28f0f2f5a543524ee174efc39f5a6d62e
  remote_operations: forbidden
  gates_consumed: []
  m02: PENDING_DEFERRED_EXTRACTION
prerequisites:
  - read PLANO_OTIMIZADO_AUTENTICACAO_E_RETOMADA.md
  - confirm branch, HEAD and worktree
  - local PostgreSQL fixture available at loopback
  - explicit local-only database/auth environment
  - official IAB capability available
  - existing Codex Security scan context retrievable
allowed_commands:
  - git rev-parse HEAD
  - git branch --show-current
  - git status -sb
  - git status --porcelain=v1
  - git diff --check
  - npm run db:up
  - npm run e2e:prepare
  - npm run build
  - npm run preview -- --host 127.0.0.1 --port 4173
  - local HTTP health checks
  - npm run m02:state:check
  - npm run m02:matrix:check
  - npm run m02:boundaries
  - official IAB get("iab") only
  - continue existing official scan by scanId
  - npm run db:down
forbidden_commands:
  - git fetch
  - git pull
  - git push
  - PR/merge/deploy operations
  - npm run m02:matrix:generate
  - docker volume rm
  - docker compose down -v
  - browser fallback or storage inspection
  - runtime/schema/migration/config edits
  - stubs or fake catalog paths
expected_evidence:
  - baseline-command-log
  - runtime-pid-and-health-log
  - official-iab-bootstrap-output
  - snapshots-for-three-routes
  - redacted-console-and-network-log
  - sentinel-create-delete-and-reset-cancel-record
  - official-scan-report-and-seal
  - populated-in-scope-files
  - m02-check-output
  - teardown-and-volume-preservation-log
  - post-op-checklist
  - sha256-manifest-external-to-self-referential-files
abort_conditions:
  - HEAD_DRIFT
  - IAB_UNAVAILABLE
  - RUNTIME_BOOT_FAILURE
  - SCAN_UNSEALED_OR_EMPTY_SCOPE
  - HASH_MISMATCH
  - WORKTREE_OUT_OF_SCOPE
  - REMOTE_OR_GATE_ATTEMPT
success_conditions:
  - OPEN-01=PASS
  - OPEN-03=PASS_WITH_SEALED_SCOPE
  - OPEN-04=PASS
  - OPEN-02=PENDING_VISIBLE
  - gates_consumed=[]
  - remote_touched=false
  - post_op_audit=PASS
```

## 11. Registro da orquestração desta autenticação

Foram despachados três subagents read-only com escopos sem sobreposição de
escrita:

| Papel                               | Escopo                                | Resultado                              | Tratamento                                         |
| ----------------------------------- | ------------------------------------- | -------------------------------------- | -------------------------------------------------- |
| Evidence/Hash Authenticator         | artefatos, hashes, scan               | sem handoff final após janelas bounded | `ABSENT-HANDOFF`; não promovido                    |
| Local State/M-02/Repo-Docs Verifier | Git local, checks M-02 e docs do repo | sem handoff final após janelas bounded | `ABSENT-HANDOFF`; fatos confirmados pelo principal |
| Reconciliation/Post-Auth Auditor    | YAML, ledger, contradições e riscos   | sem handoff final após janelas bounded | `ABSENT-HANDOFF`; não usado como aprovação         |

Os agentes foram encerrados sem tocar checkout, refs ou arquivos. Não houve
necessidade de instalar plugins: IAB, Codex Security e plugin-management já
estavam disponíveis como capacidades/skills; os rótulos operacionais de
`local-server-manager`, `iab-controller`, `security-scanner` e `ledger-scribe`
não foram tratados como plugins instalados sem ferramenta que o comprovasse.

## 12. Revisão pós-autenticação documental

**Resultado:** `POST_AUTH_AUDIT_PASS_WITH_WARNINGS`.

| Critério                         | Resultado | Justificativa                                                                                                                  |
| -------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| O plano executa remoto?          | PASS      | somente comandos locais e uma continuação oficial de scan já existente são previstos; fetch/push/PR/merge/deploy são proibidos |
| O plano consome gate?            | PASS      | gates permanecem `[]` e todos são listados como pendentes                                                                      |
| Há fallback de browser?          | PASS      | explicitamente proibido; somente `get("iab")`                                                                                  |
| Há declaração indevida de clean? | PASS      | `findingCount=0` sem selo/escopo permanece BLOCKED                                                                             |
| Há produto aprovado sem IAB?     | PASS      | product verdict permanece `NO-VERDICT`                                                                                         |
| M-02 é mascarado?                | PASS      | checks são preservados; generate/stubs/catalog edits proibidos                                                                 |
| Hashes dos artefatos anteriores  | PASS      | todos os esperados comparados; manifesto auto-validado                                                                         |
| Docs externas críticas           | WARNING   | não foram acessadas; claims externos ficam NOT-VERIFIED/DOCS-NOT-AVAILABLE                                                     |
| Handoffs dos subagents           | WARNING   | três agentes desta rodada não entregaram handoff final; ausência registrada                                                    |
| Plano foi escrito                | PASS      | este arquivo foi criado como entrega documental; não foi commitado                                                             |

O resultado geral desta autenticação não é um passe operacional. É uma
autenticação documental com advertências e dois bloqueios críticos preservados:
IAB e scan selado. O próximo agente deve começar pela Fase 0 e não pular para
P8.

## 13. Índice de evidência

- [`round.yaml`](.pi/evidence/orchestrated-open-scopes-2026-08-28/round.yaml)
- [`report.md`](.pi/evidence/orchestrated-open-scopes-2026-08-28/report.md)
- [`remote-sync-checklist.md`](.pi/evidence/orchestrated-open-scopes-2026-08-28/remote-sync-checklist.md)
- [`iab-report.md`](.pi/evidence/orchestrated-open-scopes-2026-08-28/post-op/iab-report.md)
- [`post-op-report.md`](.pi/evidence/orchestrated-open-scopes-2026-08-28/post-op/post-op-report.md)
- [`handoff.yaml`](.pi/evidence/orchestrated-open-scopes-2026-08-28/post-op/handoff.yaml)
- [`artifact-sha256.txt`](.pi/evidence/orchestrated-open-scopes-2026-08-28/post-op/artifact-sha256.txt)
- [`EXECUTION-STATE-PROGRAM.md`](EXECUTION-STATE-PROGRAM.md)
- [`docs/evidence/browser-navigation-2026-08-28.md`](docs/evidence/browser-navigation-2026-08-28.md)
- contexto oficial do scan: `8dfe96b9-03a5-4521-a840-bcbbbfb3abfe` (sem artefato selado)
- [este plano](PLANO_OTIMIZADO_AUTENTICACAO_E_RETOMADA.md)

**Hash deste plano:** deve ser calculado no handoff externo após a escrita; não
é incluído no próprio arquivo.
