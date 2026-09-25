# Runbook — Cutover A4: execução guiada do dia (T-0 → T+)

> Operação do dia D. Complementa `a4-a5-cutover.md` (sequência A4 + vigilância A5 e
> template de ledger), `hpanel-homologacao.md` (pré-requisito 11/11 PASS),
> `a4-matriz-hipoteses.md` (sondas H-xx do dia) e `hostinger-cloud-node.md`
> (rollback app-level). Cutover = **primeiro tráfego real** (não há runtime anterior).
>
> Onde a evidência ainda não existe (dry-run/restore drills em andamento na rodada
> CUTOVER-READY), este runbook referencia o CAMINHO do artefato em
> `docs/evidence/cutover-2026-09-07/` com a marca **[preencher no fechamento V6]**.

## Regra transversal do dia (drill V1)

> **"Todo passo de cutover executa via npm script; invocação direta/npx é proibida
> por serem caminhos sem guard."**
> Fonte: `docs/evidence/cutover-2026-09-07/env-guard-drill.md` (selftest 9/9 pass).

- Operações remotas de banco só na allowlist da emenda ENV-GUARD
  (`docs/specs/M-02/emenda-2026-09-07-env-guard.md` §4): `smoke:substrate`,
  `m02:readiness`, `m02:backup-verify`, `migration:legacy-to-neon`,
  `m02:env-guard-selftest` + categoria "probe de monitoramento"
  (`docs/specs/M-02/excecoes.md`). Produção com `db:migrate` é **hard-deny
  incondicional** (emenda #2 §8 — nem override nem drill-branch resgatam),
  aberto **somente** pelo caminho time-boxed da **Emenda #3** (seção 11).
- Resultado ≠ esperado → **FAIL → bundle forense (`npm run m02:forensic-bundle`;
  contrato em `docs/forensic-kit.md`) → ABORT**. Achado fora da matriz H-xx →
  PARAR e reportar. Duas falhas consecutivas no mesmo passo = PARAR e reportar.
- Evidência nunca contém valores de secrets — apenas presença/ausência de nomes.
- Slots de evidência do dia: `docs/evidence/cutover-2026-09-07/`.

## 1. Janela de freeze (antes do T-0)

O gate `m02:readiness` (check `freeze-ativo`) procura no ledger
`EXECUTION-STATE-PROGRAM.md` uma linha contendo `freeze` **e** `ativo`
(regex `/\bfreeze\b/i` + `/\bativo\b/i`). **Quem anexa: humano**, no bloco de
ledger do Manifest 4/5 da rodada CUTOVER-READY. Texto EXATO da linha a anexar:

```markdown
freeze ativo: deploys congelados da janela A4→B3 (exceção única: hotfix de segurança), declarada <DATA> — M02-D-009
```

`<DATA>` é substituída pelo humano no momento do anexo (UTC). A exceção única
(hotfix de segurança) e o reinício da janela seguem M02-D-009 §1 (owner é o
go/no-go; hotfix reinicia A5 do 0h / contagem da B3).

**Pré-condições da declaração de freeze:**

- **V2b (dados legacy, seção 13) concluída** — se `SUPABASE_MIGRATION_DATABASE_URL`
  chegou após o V2, a janela V2b roda ANTES desta declaração; **NO-GO** se
  inconclusa até **10/09**.
- **A janela do guard = a janela de freeze declarada no ledger**: os limites ISO
  usados em `NEON_MIGRATION_FREEZE_START`/`NEON_MIGRATION_FREEZE_END`
  (contrato da seção 11) devem ser exatamente os da janela A4 declarada nesta
  linha. Divergência = achado → PARAR.

| Passo                         | Comando                                         | Esperado                                                                          | Evidência                        | FAIL / ABORT                                                   |
| ----------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------- |
| 1.1 Linha de freeze no ledger | anexo humano no bloco de ledger do Manifest 4/5 | linha contendo `freeze` + `ativo` presente em `EXECUTION-STATE-PROGRAM.md`        | diff/commit do ledger            | linha ausente no T-0 → `m02:readiness` FAIL (gate) → **NO-GO** |
| 1.2 Gate enxerga a declaração | `npm run m02:readiness`                         | check `freeze-ativo` = `PASS` ("declaração de freeze ativo encontrada no ledger") | JSON do readiness (artefato 2.1) | `FAIL` → resolver no ledger antes de qualquer passo seguinte   |

## 2. T-0 — checklist ordenado (ordem obrigatória)

### 2.1 (i) Gate do dia `m02:readiness` verde

```bash
DATABASE_ADMIN_URL=<URL direct de produção> npm run m02:readiness
```

- **Natureza**: substrate via `DATABASE_ADMIN_URL` de produção — **op sancionada
  read-only** (allowlist §4 da emenda; fonte do check: `scripts/smoke/substrate-smoke.ts (DATABASE_ADMIN_URL)`).
- **Agenda humana**: `g1-assinada` exige o bloco `## G1 SIGNATURE` preenchido em
  `docs/specs/M-02/decisions/M02-D-008-G1-memo.md` (sunset **2026-09-20**) e
  `sec01-fechada` exige linha no ledger com `SEC-01` + fechamento/revogação
  (revogação no emissor das 5 credenciais de `neon-storage.env` = ação humana).
- **Esperado**: JSON `result: "PASS"`, exit 0, com os 8 checks `PASS`:
  `substrate-smoke` · `m02-matrix` · `m02-boundaries` · `m02-state` ·
  `g1-assinada` · `sec01-fechada` · `freeze-ativo` · `snapshot-fresco` (dump
  externo < 24 h).
- **Evidência**: `docs/evidence/cutover-2026-09-07/readiness-<timestamp>.json`
  **[preencher no fechamento V6]**.
- **FAIL / ABORT**: `FAIL` (exit 1) ou `INCOMPLETE` (exit 2 — ambiente não
  produziu resultado confiável) = **NO-GO**; nenhum passo seguinte inicia.

### 2.2 (ii) Matriz H-xx impressa

Imprimir/ter em mão `docs/runbooks/a4-matriz-hipoteses.md` (tabela H-01…H-14 +
design H-07 `m02:rls-probe`). Precedentes fixos do dia: BLOCKER-EXT-01
desbloqueado; URL preview temporária (nunca o domínio canônico antes do 11/11);
evidência sem valores de secrets. Cada passo deste runbook executa a sonda da
sua hipótese (seção 10).

- **FAIL / ABORT**: matriz ausente/desatualizada = **NO-GO** (princípio
  "investigar sem improvisar").

### 2.3 (iii) Snapshot DUPLA

**(a) Dump externo verificado + drill (seis passos, Emenda #6 / DP5=(b)):**

`m02:backup-verify` é exclusivamente verificador (leitura/comparação);
**não produz dump**. O produtor do dump é `m02:snapshot --out-dir`:

1. Produzir o trio com motivo por invocação e conexão direct do loader
   sancionado:
   ```bash
   DATABASE_ADMIN_URL=<URL direct da branch de origem> \
   ALLOW_REMOTE_DB="<motivo>" \
   npm run m02:snapshot -- --out-dir .artifacts/backup-drill/<data>/
   ```
   → `dump.pgc` + `dump.pgc.sha256` + `metadata.json` (`created_at` UTC =
   início da captura; trio pré-existente = exit 2, usar diretório novo).
2. Restaurar o dump em branch efêmera `restore-<data>` (kind
   `drill-branch`) pelo fluxo npm sancionado; registrar identidade e
   inventário antes/depois.
3. Reconciliar origem × restore: diff financeiro zero (origem quiescente
   ou manifesto do instante da captura).
4. Verificar origem × restore isolada (hostnames distintos exigidos):
   ```bash
   DATABASE_ADMIN_URL=<URL direct da branch de origem> \
   DATABASE_RESTORE_URL=<URL direct da branch de restore isolada> \
   npm run m02:backup-verify -- \
     --snapshot-id <snap-id> --source-branch <branch-origem> --restore-branch <branch-restore>
   ```
5. Cleanup `always()` da efêmera com prova antes/depois (ausência de
   cleanup impede selo).
6. Validar o trio pelo gate `snapshot-fresco` (idade por `created_at`,
   nunca `mtime`).

- **Esperado**: trio válido com idade < 24h por `created_at`; JSON
  `result: "PASS"` (exit 0), `comparison.pass` e `journal.pass`;
  `read_only: true`.
- **Evidência**: trio + JSON do drill + sha256 em
  `docs/evidence/cutover-2026-09-07/` **[preencher no fechamento V6 — restore
  drills em andamento]**.

**(b) Snapshot nativo Neon:**

- Registrar **ID + validade** do snapshot do dia. Referência anterior:
  `snap-tiny-smoke-ayc382ji` até **2026-10-10** — renovar se expirada.
- **Evidência**: ID + validade no ledger do dia **[preencher no fechamento V6]**.

- **FAIL / ABORT**: `m02:backup-verify` `FAIL`/`ERROR` (exit 1/2) ou snapshot
  nativo sem ID/validade registrados = **NO-GO** (rollback impossível não
  inicia cutover).

### 2.3.1 (iii-b) Reparo de grants no restore e experimento delimitado

O restore sancionado com `--no-owner --no-privileges` não restaura grants de
tabelas. O operador versionado `scripts/db/grant-repair.ts` consome o mesmo
catálogo de grants de `scripts/db/backup-verify.ts:67-77`, valida a identidade
dos dois servidores e executa o preflight **roles-before-grants** antes de
qualquer `GRANT`.

```bash
ALLOW_REMOTE_DB="C-02 grant repair: target drill-branch isolada" \
DATABASE_ADMIN_URL=<URL direct da origem> \
DATABASE_RESTORE_URL=<URL direct da branch restore> \
npm run m02:grant-repair -- \
  --source-env DATABASE_ADMIN_URL --target-env DATABASE_RESTORE_URL \
  --source-branch <branch-origem> --target-branch <branch-restore> \
  --target-kind drill-branch --apply \
  --out docs/evidence/cutover-<data>/grant-repair-<rodada>.md
```

- O plano deve mostrar `roles` requeridas, presentes antes dos grants,
  `missing=178`, `extra=0`, `mismatched=0`; o SQL gerado inclui o preflight e
  os grants faltantes, sem senha, owner privilegiado ou role `LOGIN` ausente.
- Role `LOGIN`/privileged ausente em cenário de perda de projeto =
  `BLOCKED` e provisionamento externo explícito; somente role de grupo
  `NOLOGIN` sem privilégios pode ser criada com `--create-missing-group-roles`.
- Após aplicar: `backup-verify` deve ter exit 0, `comparison.pass=true`,
  `journal.pass=true`, `read_only=true`; depois reconcile 26/26 e probe H-07
  no alvo restaurado. Falha de RLS, mesmo com catálogo PASS, = STOP e sem
  PS-S5.

**Experimento (b), separado e previamente declarado:** branch nova, mesmo
`dump.pgc`, mesmo parent e `expires-at`; executar `pg_restore --no-owner`
(sem `--no-privileges`) para testar restauração de privilégios sem repetir o
owner-transfer conhecido. Aceitação: `backup-verify` PASS (catalog completo),
reconcile 26/26, probe RLS bidirecional PASS, cleanup com prova e
`snapshot-fresco` PASS. O resultado deve ser registrado ao lado do caso (a):
PASS torna (b) o caminho primário e o reparo fallback; FAIL conserva a
sanção de (a) com causa anexada. Duas falhas consecutivas encerram a rodada;
nenhuma nova branch é criada depois do STOP.

### Decision record DR-C02A/B (2026-09-08)

Este registro é append-only e não transforma PASS parcial em aprovação. A
decisão de retomada pertence ao humano responsável; até ela, o STOP vigente
impede novas branches e qualquer escrita em produção.

| Alternativa                              | Objetivo                                                                 | Resultado/estado                                                                     | Data e condição                                                                |
| ---------------------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| (a) aceitar-com-causa + reparo de grants | Manter `--no-privileges` e reparar somente o delta de grants do catálogo | Executada em C-02A; catálogo/reconcile PASS, RLS `42P01` e BAK-01a continuam abertos | Decisão humana após diagnóstico RLS; sem PS-S5 enquanto H-07 não passar        |
| (b) re-drill privilegiado                | Testar `pg_restore --no-owner` sem `--no-privileges` em branch separada  | Não executada; impedida pelo STOP de C-02A                                           | Somente após retomada explícita e nova aceitação pré-declarada                 |
| (c) upgrade PITR/backup gerenciado       | Corrigir BAK-01b para retenção >=7 dias ou controle equivalente          | Não executada; custo/plano dependente de humano                                      | Antes de tráfego; deadline operacional G1: 2026-09-20, sem inferir contratação |

Marcos já existentes: D2/V2b até 2026-09-10, sunset G1 em 2026-09-20 e
renovação/validação do snapshot nativo antes de 2026-10-10. (c) não substitui
o teste RLS de (a)/(b); apenas trata o eixo PITR/RPO.

### 2.4 (iv) Ausência de gate.env/segredos no ambiente do dia (nomes, nunca valores)

```bash
env | grep -E '^(DATABASE_URL|DATABASE_URL_UNPOOLED|DATABASE_ADMIN_URL|DATABASE_RESTORE_URL|MIGRATION_|SUPABASE_)=' | sed 's/=.*/=<presente>/' | sort
ls gate.env 2>/dev/null; git status --short | grep -E 'gate\.env|\.env$' ; echo "checagem concluída"
```

| Nome                         | Presença esperada no ambiente do dia                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_ADMIN_URL`         | somente durante as ops sancionadas que a exigem (`m02:readiness`, `m02:backup-verify`, probe H-07)                                     |
| `DATABASE_RESTORE_URL`       | somente durante o drill de restore (endpoint isolado, hostname ≠ origem)                                                               |
| `DATABASE_URL_UNPOOLED`      | **ausente** de todo passo do dia                                                                                                       |
| `MIGRATION_*` / `SUPABASE_*` | **ausentes** do runtime web e do ambiente do dia (exceto `SUPABASE_MIGRATION_DATABASE_URL` read-only se a reconciliação T+ for viável) |
| `gate.env`                   | **ausente do repo** (segredo gerado, vive em `/tmp`, fora do versionamento)                                                            |
| `.env`                       | nunca versionado; enquanto o split (emenda §8) não ocorrer, host remoto em contexto de teste = **incidente**                           |

- **Esperado**: checklist de NOMES preenchido com presença/ausência; nenhum
  valor impresso ou registrado.
- **Evidência**: `docs/evidence/cutover-2026-09-07/env-nomes-<timestamp>.log`
  **[preencher no fechamento V6]**.
- **FAIL / ABORT**: `gate.env` presente no repo, ou `DATABASE_ADMIN_URL` fora de
  op sancionada, ou host remoto em contexto de teste → **PARAR** (freeze +
  investigação).

### 2.5 (v) Role membership do runtime — `m02:role-membership` (GAP-TOOLING **fechado por ordem de runbook + script**)

> Nota anterior (evidence.json da rodada CUTOVER-READY): "`db:migrate` não
> invoca `ensureRuntimeRoleMembership`… smoke A4 criará em produção".
> **Fechado**: passo ordenado aqui (antes do smoke §5) + operador dedicado
> `scripts/m02-role-membership.mjs` (`npm run m02:role-membership`), que reusa a
> fonte de verdade `scripts/db/migrate.ts` (`ensureRuntimeRoleMembership`,
> idempotente) — drill de idempotência 2× com diff de estado vazio em
> `docs/evidence/cutover-prep-2026-09-07/role-membership-test-2026-09-07.md`.

```bash
ALLOW_REMOTE_DB="cutover A4 T-0: membership admin→app_runtime antes do smoke (H-07 exige SET ROLE)" \
NEON_MIGRATION_TARGET_KIND=cutover-window \
NEON_MIGRATION_FREEZE_START=<ISO-8601 da janela A4> \
NEON_MIGRATION_FREEZE_END=<ISO-8601 da janela A4> \
T0_MEMBERSHIP_URL=<URL direct de produção> \
npm run m02:role-membership -- --target-env T0_MEMBERSHIP_URL --kind cutover-window \
  --out docs/evidence/cutover-2026-09-07/role-membership-t0.md
```

- **Natureza**: única escrita de catálogo sancionada na janela (grant `SET
OPTION` idempotente, Emenda #3 — fora da janela o operador nega **pré-conexão**
  com exit 3; produção fora da janela permanece hard-deny).
- **Esperado**: exit 0; JSON com `before.has_set_membership` (dia-D: `false`,
  lido hoje 2026-09-07 read-only) → `after.has_set_membership=true`;
  2ª execução = no-op (`idempotent_noop=true`).
- **Ordem obrigatória**: este passo executa **ANTES da seção 5 (smoke A4)** —
  a sonda H-07 faz `SET ROLE app_runtime` e falharia 42501 sem membership — e
  depois do `db:migrate` da janela (a role `app_runtime` vem das migrations).
- **FAIL / ABORT**: exit 3 fora da janela = ambiente errado (conferir as envs
  da Emenda #3; nunca contornar — regra V1); exit 2 = PARAR e reportar.

## 3. Homologação hPanel 11/11 ANTES de apontar o domínio

Executar integralmente o runbook `hpanel-homologacao.md` (11 itens, H-01…H-11/H-14)
na **URL preview temporária** — o domínio canônico só é apontado **depois** do
11/11 com evidência. Resumo de gate:

| Item (hPanel)            | Sonda H-xx | Gate de saída                                                               |
| ------------------------ | ---------- | --------------------------------------------------------------------------- |
| 1 Node ≥ 24.15           | H-01       | teto < 24.15.0 = **ABORT geral**                                            |
| 2/3/4 start/porta/host   | H-02       | processo do artefato + preview roteia                                       |
| 5/6 persistência/restart | H-03/H-08  | 3× `live` 200 em 15 min; novo PID; live ≤ 60 s pós-kill                     |
| 7 logs sem secrets       | H-09       | grep de segredos = `0`; **qualquer segredo em claro = FAIL**                |
| 8 proxy timeout > 60 s   | H-04       | corte ≤ 60 s = FAIL (ajustar `AI_REQUEST_TIMEOUT_MS` ou plano)              |
| 9 egress TLS             | H-05       | 3/3 alcançáveis; **Neon bloqueado = ABORT**                                 |
| 10 health live+ready     | H-10       | `live ≠ 200` = FAIL; `ready` 503 = app viva + DB indisponível (bloqueia A4) |
| 11 secrets por ambiente  | H-11/H-14  | `DATABASE_ADMIN_URL` no web = FAIL; secrets cruzando ambientes = FAIL       |

- **Gate de saída**: 11/11 `PASS` com evidência numerada 01–11 em
  `docs/evidence/hpanel-homologacao-<AAAA-MM-DD>/` → atualizar
  `docs/evidence/hostinger-hpanel-verification.md`; **só então** apontar o
  domínio e iniciar o deploy (seção 4).
- **Evidência do dia**: slot do homologação **[preencher no fechamento V6]**.

## 4. Deploy

| Passo | Comando                                                                             | Esperado                                                                                 | Evidência                            | FAIL / ABORT                                    |
| ----- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| 4.1   | `git rev-parse main` + conferência do SHA no ledger do dia                          | SHA de `main` registrado antes do build                                                  | ledger do dia                        | SHA divergente = PARAR                          |
| 4.2   | `npm ci && npm run build && npm run check:hostinger-runtime`                        | build PASS; smoke degradado `PASS ...: live=200 ready=503` (não é readiness de produção) | saída dos scripts                    | qualquer FAIL = PARAR                           |
| 4.3   | publicar o artefato do SHA (`.output/server/index.mjs` identificável por commit)    | artefato publicado corresponde ao SHA de 4.1                                             | registro hPanel + SHA                | artefato sem commit identificável = PARAR       |
| 4.4   | checklist de env vars **por NOME** (tabela abaixo) no painel                        | nomes exigidos presentes; proibidos ausentes                                             | captura de NOMES (nunca valores)     | ADMIN/legado no web = FAIL (H-11/H-14) → ABORT  |
| 4.5   | start = `npm run start` (`node .output/server/index.mjs`)                           | processo persistente do artefato publicado                                               | `02-start-cmd.{log,png}` equivalente | sem comando custom / processo divergente = FAIL |
| 4.6   | `ps aux \| grep -F '.output/server/index.mjs'` + logs de boot (porta/host efetivos) | processo no ar; `PORT`/`NITRO_PORT` e `HOST`/`NITRO_HOST` efetivos conferidos            | ps + log de boot (redigido)          | porta/host divergentes = FAIL                   |
| 4.7   | `grep -Ei 'postgres://\|api[_-]?key\|secret\|password\|token' <trecho> \| wc -l`    | `0` (H-09)                                                                               | trecho de log redigido               | qualquer segredo em claro = FAIL + ABORT        |

**Checklist de env vars por NOME** (fonte: `hostinger-cloud-node.md` §Variáveis;
homologação item 11):

| Presentes (exigidas)                                                                                                                                                                                                        | Proibidas (ausentes do web)                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `DATABASE_URL` (pooled) · `DATABASE_DRIVER=node-postgres` · `BETTER_AUTH_URL` · `BETTER_AUTH_SECRET` · `AUTH_TRUSTED_ORIGINS`                                                                                               | `DATABASE_ADMIN_URL`                                                                 |
| `RESEND_API_KEY` · `AUTH_EMAIL_FROM` (fluxos Resend)                                                                                                                                                                        | `SUPABASE_*` (incl. `SUPABASE_MIGRATION_DATABASE_URL`)                               |
| `AI_GATEWAY_URL` · `AI_GATEWAY_API_KEY` · `AI_MODEL` · `AI_REQUEST_TIMEOUT_MS` · `AI_MODEL_TIMEOUT_MS` · `AI_MODEL_MAX_ATTEMPTS` · `AI_MAX_TOOL_ROUNDS` · `AI_CHAT_LIMIT_PER_10_MINUTES` · `AI_DAILY_CHAT_LIMIT_PER_TENANT` | `MIGRATION_*` (`MIGRATION_APPLY`, `MIGRATION_ALLOW_UPSERT`, `MIGRATION_REPORT_PATH`) |

## 5. Smoke A4 com tolerância a cold start

**Justificativa (keep-warm §T2.4, G-SEC-EXEC E3.4):** o probe sancionado
read-only na produção mediu TTFF a frio ×3 = **1683,6 / 2135,6 / 2214,8 ms**
(média ~2011 ms) com auto-suspend de **304–316 s** — a 1ª requisição pós-idle
paga ~2,0–2,2 s (fora do p95 500 ms §29 **somente nessa requisição**). Opção
(i) "aceitar" permanece a recomendada para A4/A5; decisão (ii)/(iii) é da B3.
Portanto: **warm-up request antes das asserções OU timeout ≥ 3 s nas asserções**.

```bash
# (a) warm-up — 1 requisição descartável que paga o TTFF a frio (recomendada)
curl -s -o /dev/null -w '%{http_code} %{time_total}\n' https://<domínio>/api/health/live

# (b) asserções com --max-time ≥ 3
curl -i --max-time 3 https://<domínio>/api/health/live    # esperado HTTP 200
curl -i --max-time 3 https://<domínio>/api/health/ready   # esperado HTTP 200

# (c) substrate (read-only, op sancionada)
npm run smoke:substrate                                    # esperado PASS 7/7
```

Checks do `smoke:substrate` (H-12/H-13): `postgres-major` (17) ·
`journal-count` · `journal-hashes` · roles (`app_runtime` sem superuser/BYPASSRLS) ·
`tenant-tables-rls` · `accounts-issuer-null` (= 0) ·
`production-fixture-free` (26/26 tabelas zero `@preco-que-da.test`).

**RLS adversarial (H-07)** — sonda `m02:rls-probe`, design "Design H-07" da
matriz; **executa SOMENTE neste passo** (smoke A4 a): 2 tenants + 2 usuários
marcadores `@preco-que-da.test` via `DATABASE_ADMIN_URL` (única escrita
sancionada do dia, IDs/valores fixos, parâmetros vinculados) → conexões
`app_runtime` (pooled) com `set_config(..., true)` tentam `SELECT`/`INSERT`/`UPDATE`
cross-tenant → **todas as tentativas negadas**. Cleanup sancionado:
`npm run db:purge-fixtures` (dry-run default; aplicar com a flag explícita) +
re-run `npm run smoke:substrate` → `production-fixture-free` 26/26 zero.
Regra do drill V1 aplicável: a sonda executa via npm script; entrada npm
ausente no dia = achado → PARAR e reportar (nunca invocação direta). Alternativa
zero-escrita (se houver veto): branch-cópia a partir do snapshot pré-deploy,
rotulada "runtime RLS em réplica" (não fecha o residual §42).

Restrição vigente para C-02A e qualquer retomada pós-STOP: o seed somente pode
usar `DATABASE_RESTORE_URL` em branch `drill-branch`, com endpoint direct,
motivo `ALLOW_REMOTE_DB` e `NEON_MIGRATION_TARGET_KIND=drill-branch`. O script
recusa o endpoint de produção antes de conectar. A redação histórica de seed
direto em produção não é executável nesta rodada, pois produção permanece
read-only e apenas o alvo efêmero pode receber writes.

**Autenticação (conta controlada):**

| Passo                   | Esperado                                               |
| ----------------------- | ------------------------------------------------------ |
| login com senha correta | sessão criada                                          |
| login com senha errada  | rejeitado                                              |
| logout + relogin        | sessão encerrada e recriada                            |
| acesso sem sessão       | bloqueado                                              |
| better-auth em tráfego  | 1.7.x com **issuer preenchido** (`issuer IS NULL` = 0) |

- **Evidência**: JSON do `smoke:substrate` + logs de asserção em
  `docs/evidence/cutover-2026-09-07/` **[preencher no fechamento V6]**.
- **FAIL / ABORT**: qualquer check ≠ esperado → FAIL → `npm run m02:forensic-bundle`
  → **ABORT** + rollback app-level (`hostinger-cloud-node.md` §Operação);
  negação RLS ausente = **VIOLAÇÃO crítica** → ABORT; `ready` 503 = bloqueia A4.

## 6. Monitoração (janela pós-deploy)

Janelas A5 0h/24h/72h (`a4-a5-cutover.md`); re-probes seguem a emenda
"probe de monitoramento" (`docs/specs/M-02/excecoes.md`): leitura por padrão,
evidência datada (JSON + SHA-256), delta classificado.

| Indicador                            | Fonte / comando                                                                                     | Esperado vs baseline 0h                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Error rate (erros por código)        | logs estruturados (sem secrets — H-09)                                                              | sem regressão; sem P0/P1                                |
| Pool saturation (Plano Mestre §16.7) | **wait time · active transactions · pool queue · connections** (stats de pool da baseline 0h; H-06) | sem saturação com o tráfego real; zero erros de conexão |
| Spike 401                            | contagem de 401 vs 0h                                                                               | zero spike                                              |
| 429 / `rate_limits`                  | contagens vs 0h                                                                                     | sem anomalia                                            |
| Latência `app.*`                     | métricas `app.*` (3 amostras) vs baseline 0h                                                        | sem regressão                                           |

**Critérios de abort da A5 (qualquer um dispara rollback — seção 7):**

- erro financeiro crítico ou cross-tenant observado em produção;
- `ready` 5xx sustentado > 15 min com banco acessível;
- spike de 401 pós-deploy (sessão/issuer quebrados);
- divergência financeira inexplicada;
- `npm run smoke:substrate` FAIL em qualquer reexecução da janela.

## 7. Rollback (Plano Mestre §13.7 completo)

**Pré-condição da janela: ORIGEM read-only** (manutenção mantida durante toda a
janela de rollback — §13.6 item 7). Sem dual-write; sem copiar escritas de volta
à origem.

| #   | Passo (§13.7)                                     | Execução                                                                                                                                                                                                | FAIL / ABORT                                                             |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Manter origem em manutenção/read-only             | runtime Supabase em manutenção; nenhuma escrita na origem                                                                                                                                               | escrita na origem = PARAR (contaminação do delta)                        |
| 2   | Restaurar `DATABASE_URL` anterior                 | **pré-escrita**: restaurar secrets/runtime anterior e apontar o processo para o **artefato anterior por commit** (`hostinger-cloud-node.md` §Operação: apontar artefato anterior → reiniciar → validar) | sem artefato identificável = PARAR                                       |
| 3   | Reabrir origem                                    | retirar manutenção após o runtime anterior validado                                                                                                                                                     | —                                                                        |
| 4   | Validar live/ready no destino de rollback         | `curl -i --max-time 3 https://<destino>/api/health/live` → 200 e `.../ready` → 200                                                                                                                      | destino de rollback sem 200/200 = incidente P0                           |
| 5   | Registrar delta                                   | divergências observadas registradas no ledger do dia (contagens por tabela, timestamps) **[preencher no fechamento V6]**                                                                                | delta não registrado = violação de ledger                                |
| 6   | **NUNCA consertar em produção sem reconciliação** | nenhum "conserto" manual em produção; correção só via reconciliação (seção 8)                                                                                                                           | mutação ad-hoc em produção = violação da norma de mutação (M02-D-009 §3) |
| 7   | **Pós-escrita** (se houve escrita no Neon)        | manter manutenção + **restore do snapshot pré-deploy** (nativo + `dump.pgc`; PITR 6h é camada adicional — BAK-01 aberta); depois seguir passos 3–6                                                      | rollback parcial sem snapshot = PARAR                                    |

**Guarda de issuer:** **nunca** executar `drizzle/rollback/0010_to_0009_down.sql`
com contas presentes — a guarda **aborta por desenho**; rollback de issuer
pós-tráfego = snapshot, não down-migration. `0010_to_0009_down.sql` permanece
LOCKED (nunca é caminho de rollback do A4 — matriz H-07).

## 8. T+ (reconciliação)

Terceiro reuso (iii) do **script-âncora de reconciliação** — contrato CLI na
seção 12 (`scripts/m02-reconcile.mjs`, origem×alvo por NOME de env, saída §13.5)
— **production×legacy**, quando as credenciais legacy existirem
(`SUPABASE_MIGRATION_DATABASE_URL` read-only com acesso a `auth` e `public`).
Caminho já sancionado no `package.json` enquanto o wrapper do script-âncora
não está wired: `MIGRATION_APPLY=false npm run migration:legacy-to-neon`
(wrappers `scripts/migration/source-to-neon.ts` + `scripts/migration/reconcile.ts`;
allowlist §4 da emenda). Invocação sempre via npm script (regra V1).

- **Estado hoje**: credenciais legacy = **DESCONHECIDO · dono humano** — ver
  `docs/evidence/cutover-2026-09-07/dryrun-notes.md` (1º/2º reusos na rodada
  CUTOVER-READY) **[preencher no fechamento V6]**.
- **Contrato do relatório** (gate Neon readiness, `migracao-supabase-neon.md`):
  `sourceMode=read-only-repeatable-read`, `different=0`, `sessionsImported=0`,
  zero órfãos. Relatório com exceção operacional sensível não é publicado.
- **Se as credenciais não existirem**: a reconciliação scriptada fica
  **DESCONHECIDO** (dono humano); a decisão 72h segue com a reconciliação
  contábil leve do A5 (`a4-a5-cutover.md`: contagens por tabela sem divergência
  inexplicada) e a decisão final registra a lacuna.
- **Evidência**: `docs/evidence/cutover-2026-09-07/reconcile-tplus.md`
  **[preencher no fechamento V6]**.
- **FAIL / ABORT**: `different ≠ 0` ou órfãos em tabela financeira = critério de
  abort da seção 6 → rollback + reconciliação antes de qualquer conserto.

## 9. Carimbos de ledger

```bash
date -u +%FT%TZ   # deployed_at (após 4.5/4.6) e smoke_passed_at (após smoke 5 PASS 7/7)
```

- Registrar `deployed_at` e `smoke_passed_at` (UTC ISO-8601) no template de
  ledger A5 (`a4-a5-cutover.md`). **Sem os dois carimbos, A5 não inicia.**
- Atualizar a linha **ESTADO DO SUBSTRATO** do ledger:

```markdown
ESTADO DO SUBSTRATO: Tráfego: EXISTE (primeiro registro) — <deployed_at UTC>; smoke <PASS 7/7>; snapshot <snap-id-do-dia>; rollback <artefato anterior por commit>
```

| Carimbo             | Momento                    | Evidência                             | FAIL / ABORT                                                    |
| ------------------- | -------------------------- | ------------------------------------- | --------------------------------------------------------------- |
| `deployed_at`       | imediatamente após 4.6     | ledger + saída de `date -u`           | ausente = A5 não inicia                                         |
| `smoke_passed_at`   | imediatamente após seção 5 | ledger + JSON do smoke                | ausente = A5 não inicia                                         |
| ESTADO DO SUBSTRATO | fechamento do A4           | linha no `EXECUTION-STATE-PROGRAM.md` | substrato sem a virada "Tráfego: EXISTE" = ledger inconsistente |

## 10. Referências cruzadas

| Documento                                                                                     | Papel no dia                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/runbooks/a4-matriz-hipoteses.md`                                                        | sondas por item: H-01…H-14; design H-07 (`m02:rls-probe`); DESCONHECIDOS declarados                                                        |
| `docs/evidence/cutover-2026-09-07/env-guard-drill.md`                                         | regra "todo passo via npm script"; selftest 9/9; cenário 8 (produção hard-deny)                                                            |
| `docs/specs/M-02/emenda-2026-09-07-env-guard.md` (§4, §8/emenda #2, **emenda #3**)            | allowlist de ops sancionadas; drill-branch sancionado; produção hard-deny incondicional aberto só pelo caminho `cutover-window` (seção 11) |
| `docs/evidence/cutover-2026-09-07/dryrun-notes.md`                                            | reusos (i)/(ii) do script-âncora e janela V2b **[preencher no fechamento V6]**                                                             |
| `scripts/m02-role-membership.mjs` (`npm run m02:role-membership`)                             | passo T-0 (v): garante membership `app_runtime` ANTES do smoke §5 (GAP-TOOLING fechado)                                                    |
| `docs/evidence/cutover-prep-2026-09-07/role-membership-test-2026-09-07.md`                    | drill de idempotência (2×, diff vazio) + cleanup com prova + produção inalterada                                                           |
| `docs/specs/M-02/excecoes.md` (emenda "probe de monitoramento")                               | re-probes da A5 sancionados: leitura, JSON + SHA-256, classificação de delta                                                               |
| `docs/runbooks/a4-a5-cutover.md`                                                              | gate do dia (`m02:readiness`), janelas 0h/24h/72h, template de ledger A5                                                                   |
| `docs/runbooks/hpanel-homologacao.md`                                                         | pré-requisito 11/11 antes do domínio (seção 3)                                                                                             |
| `docs/runbooks/hostinger-cloud-node.md` (§Operação)                                           | rollback app-level: artefato anterior por commit                                                                                           |
| `docs/runbooks/migracao-supabase-neon.md`                                                     | cutover de dados; contrato do relatório de reconciliação                                                                                   |
| `docs/specs/M-02/decisions/M02-D-009-change-freeze.md`                                        | freeze A4→B3, exceção única (hotfix), norma de mutação                                                                                     |
| `docs/specs/M-02/decisions/M02-D-008-G1-memo.md`                                              | agenda G1 (sunset 2026-09-20) exigida pelo gate                                                                                            |
| Plano Mestre (`docs/PLANO_MESTRE_OTIMIZACOES_VALIDADO_WEB_PRECO_QUE_DA_LUCRO.md`) §13.6/§13.7 | janela de freeze/rollback (seções 1 e 7)                                                                                                   |
| Plano Mestre §16.7/§16.8                                                                      | pool saturation (wait time, active txs, queue, connections); cold activation                                                               |
| `docs/evidence/gsec-2026-09-06/designs-endurecimento.md` (§T2.4)                              | keep-warm: TTFF a frio 1683,6/2135,6/2214,8 ms; auto-suspend 304–316 s (justificativa da seção 5)                                          |
| `docs/forensic-kit.md`                                                                        | contrato do bundle forense (`npm run m02:forensic-bundle`)                                                                                 |
| ADR-021 §9                                                                                    | destino único; origem congelada (retenção) na decisão 72h                                                                                  |
| Seções 11–13 deste runbook                                                                    | Emenda #3 (`cutover-window`), contrato CLI do script-âncora, janela V2b (pré-freeze)                                                       |

## 11. Emenda #3 — migration em produção time-boxed (`cutover-window`)

A emenda #2 (§8 do arquivo da emenda) aplica **hard-deny incondicional** a
`db:migrate` contra endpoints de produção. A **Emenda #3** (rodada
CUTOVER-READY pós-V1) define o **ÚNICO** caminho que abre esse hard-deny:
migration em produção **time-boxed** pela janela de freeze. **Fora da janela →
DENY** (exit 3), sem exceção.

**Contrato exato das 3 envs** (todas obrigatórias no ambiente do hook
`predb:migrate`; o guard valida antes do comando):

| Env                                                         | Contrato                                                                                                                                                                  |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEON_MIGRATION_TARGET_KIND=cutover-window`                 | seleciona o caminho time-boxed; qualquer outro valor mantém o hard-deny da emenda #2 (drill-branch só serve branch de drill — cenário 7/8 do drill V1)                    |
| `ALLOW_REMOTE_DB=<motivo>`                                  | motivo **não-vazio**; entra no log de auditoria (§5 da emenda)                                                                                                            |
| `NEON_MIGRATION_FREEZE_START` / `NEON_MIGRATION_FREEZE_END` | ISO-8601; o guard valida que "agora" está dentro da janela — mesmo padrão `expiresOn` do WARN-NITRO-001 (`scripts/build.mjs`: comparação de data, expirado = fail-closed) |

**Comando (único caminho sancionado para migration em produção, dentro da janela):**

```bash
ALLOW_REMOTE_DB="<motivo>" \
NEON_MIGRATION_TARGET_KIND=cutover-window \
NEON_MIGRATION_FREEZE_START=<ISO-8601> \
NEON_MIGRATION_FREEZE_END=<ISO-8601> \
npm run db:migrate
```

**Log de allow** (linha de auditoria do guard, a registrar na evidência do dia):

```json
{
  "path": "cutover-window",
  "freezeStart": "<ISO-8601>",
  "freezeEnd": "<ISO-8601>",
  "motivo": "<motivo>"
}
```

**Regra de amarração com o ledger:** a janela do guard = a janela de freeze
declarada no ledger (seção 1) — `NEON_MIGRATION_FREEZE_START`/`END` devem ser
exatamente os limites da janela A4 da linha "freeze ativo".

- **FAIL / ABORT**: DENY durante a janela declarada = ambiente errado (conferir
  as 3 envs no hook `predb:migrate`; nunca contornar com invocação direta — regra V1);
  ALLOW fora da janela = bug do guard → **PARAR** (freeze + investigação) e
  registrar na emenda; produção fora da janela permanece hard-deny (nem override,
  nem drill-branch, nem `cutover-window` resgatam).

## 12. Contrato CLI do `scripts/m02-reconcile.mjs` (script-âncora, 3 reusos)

```text
node scripts/m02-reconcile.mjs --source-env <ENV> --target-env <ENV> --out <arquivo.md>
```

- Origem×alvo parametrizáveis **por NOME de env** (ex.: `production`, `dryrun`,
  `restore`, `legacy`) — **nunca URL em argv** (URLs ficam em env/arquivos
  explicitamente nomeados, carregados só pela op sancionada — emenda §8).
- Saída no formato **§13.5 do Plano Mestre** (relatório de reconciliação:
  `table / source_count / target_count / difference / status`), gravado em
  `--out <arquivo.md>`.
- Regra do drill V1 aplicável: no dia, a invocação é feita pelo wrapper npm da
  rodada (o contrato acima é do script-âncora); o guard deve estar no caminho.

**3 reusos declarados:**

| Reuso | Rodada       | Origem × alvo                                        | Momento                                |
| ----- | ------------ | ---------------------------------------------------- | -------------------------------------- |
| (i)   | V2           | production × dryrun (branch de drill)                | dry-run de migração                    |
| (ii)  | V4           | production × restore (branch restaurada do snapshot) | prova de restore                       |
| (iii) | T+ (seção 8) | production × legacy                                  | só quando credenciais legacy existirem |

- Evidência dos reusos (i)/(ii): `docs/evidence/cutover-2026-09-07/dryrun-notes.md`
  **[preencher no fechamento V6]**.
- **FAIL / ABORT**: `difference ≠ 0` em tabela financeira sem explicação = critério
  de abort da seção 6; script ausente no dia (entrada npm não wired) = achado → PARAR.

## 13. Janela V2b (dados legacy) — pré-requisito da declaração de freeze

Se `SUPABASE_MIGRATION_DATABASE_URL` (read-only, acesso a `auth` e `public`)
chegar após o V2, executar a janela **V2b ANTES da declaração de freeze**
(seção 1):

1. carga legacy na branch dryrun (Neon, branch isolada §12.4);
2. reconcile completo **legacy×Neon** (contrato CLI da seção 12);
3. schema diff **legacy×Neon**.

- **NO-GO** se a V2b estiver inconclusa até **10/09**.
- **Regra de ledger**: paridade legacy×Neon = **MEDIDA-EM-CÓPIA** somente após a
  V2b concluída; até lá permanece **DESCONHECIDA**, com dono humano (D2).
- Produção permanece read-only/intocada durante toda a V2b (tudo em cópia).
- Evidência: `docs/evidence/cutover-2026-09-07/dryrun-notes.md`
  **[preencher no fechamento V6]**.
- **FAIL / ABORT**: reconcile com `difference ≠ 0` em tabela financeira sem
  explicação, ou schema diff sem triagem (CONFORME / GAP-DOC / VIOLAÇÃO /
  FALSO-ALARME / DESCONHECIDO) → paridade permanece DESCONHECIDA → **NO-GO**
  do freeze até resolução ou 10/09.
