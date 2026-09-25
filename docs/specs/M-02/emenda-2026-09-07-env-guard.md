# Emenda 2026-09-07 — ENV-GUARD: proibição de teste/dev/mutação contra banco remoto

Emenda à norma M-02 (`docs/specs/M-02/spec.md`). Origem: rodada G-SEC-EXEC, item
T2.1 — prioridade máxima (`docs/evidence/gsec-2026-09-06/designs-endurecimento.md`,
§T2.1). Vigor a partir de 2026-09-07. O wiring executável nos hooks do
`package.json` entra pelo Manifest 3 (§7) — esta emenda não altera scripts
existentes.

## 1. Hazard

O `.env` do checkout aponta `DATABASE_URL`/`DATABASE_URL_UNPOOLED` para o Neon
de **produção** (`ep-long-violet-aye9g0bn[-pooler]`). `vite dev`, `tsx` e
scripts que auto-carregam `.env` podem ler/escrever produção sem intenção. A
proteção até aqui era checagem manual do agente (a Fase 0 bloqueou corretamente
a suíte contra Neon) — **a checagem manual não pode continuar sendo a
proteção** (GAP-DOC da norma).

## 2. Norma

Nenhum comando de teste, mutação de schema ou servidor de dev pode conectar a
banco com hostname fora de {`127.0.0.1`, `localhost`, `::1`}. Operações remotas
existem apenas na allowlist de ops sancionadas (§4), cada uma com evidência
própria.

## 3. Conjunto DENY (exit 3)

- **Scripts**: `test`, `dev`, `build:dev`, `e2e:prepare`, `test:e2e`, `db:test`,
  `db:migrate`, `db:generate`, `db:check`.
- **Envs examinadas**: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`,
  `DATABASE_ADMIN_URL`, `DATABASE_RESTORE_URL`.
- **Hostname local**: apenas {`127.0.0.1`, `localhost`, `::1`}; qualquer outro
  hostname (incl. `*.neon.tech`, link-local `169.254.x`) é remoto.
- **Fail-closed**: URL malformada (ou sem host) = deny, com o valor omitido da
  mensagem; erro interno do guard = exit 2, nunca allow.

## 4. Allowlist de ops sancionadas (remoto permitido)

| Script                         | Natureza                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `smoke:substrate`              | sonda read-only de substrate (cutover A4)                                    |
| `m02:readiness`                | verificação de readiness pós-cutover                                         |
| `m02:backup-verify`            | drill autorizado de verificação de backup                                    |
| `migration:legacy-to-neon`     | migração sancionada legacy → Neon, com evidência                             |
| `m02:env-guard-selftest`       | selftest do guard (envs sintéticas em memória)                               |
| `m02:snapshot` **(Emenda #4)** | snapshot `pg_dump -Fc` read-only via DIRECT (cutover-prep baseline; ver §10) |

Sondas de monitoração seguem a categoria "probe de monitoramento" da Emenda
2026-09-06 (`docs/specs/M-02/excecoes.md`): leitura por padrão, evidência
datada (JSON + SHA-256) e classificação de qualquer delta. Qualquer operação
remota fora desta allowlist é **violação da norma** (freeze + investigação).

## 5. Override `ALLOW_REMOTE_DB`

- `ALLOW_REMOTE_DB=<motivo>`, com motivo **não-vazio**, permite que um script
  do conjunto DENY rode contra banco remoto. Cada uso imprime linha de log JSON
  `{guard:"env-guard", override:true, script, motivo}` e deve ser registrado na
  evidência da rodada correspondente.
- **`db:migrate` não aceita override**: migração contra banco remoto exige
  `MIGRATION_APPLY` + manifest próprio; o guard nega (exit 3) mesmo com o
  override definido.
- Override não resgata URL malformada (§3, fail-closed).

## 6. Contrato do script `scripts/env-guard.mjs`

- **Alvo**: `npm_lifecycle_event` ou `--script=<nome>`; hooks `pre*` do npm são
  normalizados quando o sufixo é um script conhecido (ex.: `pretest` → `test`,
  `predb:test` → `db:test`); nomes como `preview` ficam intactos.
- Scripts fora do conjunto DENY e da allowlist: **allow sem opinião** (exit 0).
- **Exit codes**: `0` allow · `3` deny · `2` erro interno (fail-closed) ·
  selftest reprovado sai `1`.
- Sem dependências; nunca conecta a nada; nunca imprime valores de env —
  somente hostnames. A mensagem de deny é JSON
  `{guard:"env-guard", result:"DENY", script, env, host, remedio, norma}` com
  remédio "usar banco local (`npm run db:up`) + `.env` local".
- Selftest: `node scripts/env-guard.mjs --selftest` roda a matriz com envs
  sintéticas em memória (sobrescreve e restaura `process.env`), imprimindo
  `{case, expected, got, pass}` por caso; exit 0 só se todos passarem.

## 7. Wiring (entra pelo Manifest 3)

Ligação por hooks `pre*` do npm (`pretest`, `predev`, `predb:test`, …): o guard
roda **antes** do comando, com zero mudança nos scripts existentes. O registro
dos hooks é item do Manifest 3.

Nota de implementação: o guard avalia apenas o ambiente do processo — ele não
lê arquivos `.env`. O wiring deve garantir que as variáveis de conexão estejam
no ambiente do hook (export ou `node --env-file`), pois ferramentas como
`vite`/`tsx` carregam `.env` depois do hook.

## 8. Fix associado: split do `.env`

O `.env` → produção permanece **hazard ativo** (§1) até o split: `.env` conterá
apenas configuração de dev-local; credenciais de produção migram para arquivo
explicitamente nomeado, carregado exclusivamente pelas ops sancionadas (§4).
Enquanto o split não ocorrer, toda rodada deve tratar presença de host remoto
em contexto de teste como incidente.

## 9. Verificação

- **Selftest** (`node scripts/env-guard.mjs --selftest`, exit 0): local+test =
  allow; remoto+test = deny; remoto+`smoke:substrate` = allow;
  remoto+test+override = allow com log; remoto+`db:migrate`+override = deny;
  URL malformada+test = deny; sem envs+test = allow.
- **Smoke de negação**: `DATABASE_URL=<url remota sintética> node
scripts/env-guard.mjs --script=test` → exit 3, sem imprimir a URL.
- **Smoke de negação real** (pós-wiring, Manifest 3): `npm test` com
  `DATABASE_URL` remoto deve falhar com exit 3.

## 8. Emenda #2 (2026-09-07, rodada CUTOVER-READY) — caminho sancionado de migração em branch de drill

O DENY incondicional de `db:migrate` contra host remoto bloqueia também o
dry-run de migração em **branch de drill Neon** (§12.4 isolada, §12.5 efêmera),
exigido pelo gate §42 ("migrations em cópia de produção"). Fica sancionado:

- `db:migrate` com `NEON_MIGRATION_TARGET_KIND=drill-branch` +
  `ALLOW_REMOTE_DB=<motivo>` → **ALLOW com log** quando o hostname alvo NÃO é
  endpoint de produção;
- endpoints de produção (`ep-long-violet-aye9g0bn` e variante `-pooler`) sofrem
  **hard-deny incondicional** — override + drill-branch não resgatam;
- a linha de log do allow carrega `path:"drill-branch"`, script, host e motivo;
- exigência do runbook de cutover: a branch de drill é deletada no fim do V4
  com prova de cleanup (§12.5 always()).

## 9. Emenda #3 (2026-09-07, rodada CUTOVER-READY pós-V1) — janela de freeze do cutover (time-boxed)

A emenda #2 mantém **hard-deny incondicional** de `db:migrate` contra os
endpoints de produção. A migração em produção no dia do cutover (T-0) exige um
único caminho sancionado e **time-boxed** (padrão `expiresOn` do
WARN-NITRO-001):

- `NEON_MIGRATION_TARGET_KIND=cutover-window` + `ALLOW_REMOTE_DB=<motivo>` +
  `NEON_MIGRATION_FREEZE_START` / `NEON_MIGRATION_FREEZE_END` (ISO 8601) —
  o guard valida que "agora" ∈ [start, end];
- fora da janela, janela malformada, ou sem motivo → **DENY**;
- o log do allow carrega `path:"cutover-window"`, `freezeStart`, `freezeEnd` e
  motivo;
- a janela do guard É a janela de freeze declarada no ledger pelo runbook
  `docs/runbooks/cutover-A4.md` §1 (mesmas datas);
- selftest: janela vigente → ALLOW; expirada → DENY; futura/ausente → DENY;
  sem motivo → DENY; produção sem cutover-window → DENY (emenda #2).

Esta emenda não amplia permissões fora da janela: é o mecanismo que torna o
hard-deny da #2 compatível com o único momento do programa em que migração em
produção é legítima (o próprio cutover).

## 10. Emenda #4 (2026-09-07, rodada CUTOVER-PREP) — `m02:snapshot` na allowlist sancionada (read-only dump)

A rodada CUTOVER-PREP mecaniza a dupla snapshot do T-0 (runbook §2.3) e o
baseline de recuperação (deadline de renovação do snapshot nativo: antes de
**20/09**). Fica sancionada a operação:

- `m02:snapshot` (`scripts/m02-snapshot.mjs`) → **ALLOW_SANCTIONED com log**
  quando houver env de conexão remota apontando alvo DIRECT;
- natureza estritamente **read-only**: `pg_dump -Fc` (somente `ACCESS SHARE`;
  nenhum DML/DDL emitido), sempre via **DIRECT** (o script recusa host
  `-pooler`), cliente `pg_dump` 17.x do container local;
- artefatos: `artifacts/snapshots/snapshot-<data>.dump` + `.sha256`
  (root-relative, verificável com `sha256sum -c` a partir da raiz) +
  `metadata.json` (versão do servidor, tamanho, duração, origem rotulada,
  host mascarado, prova read-only);
- cada execução exige **motivo logado** na evidência da rodada (mesma norma
  dos demais allow com override/§5).

**Limites — esta emenda NÃO**:

- **não relaxa o hard-deny de `db:migrate` contra produção** (Emenda #2
  permanece incondicional fora da janela da #3; snapshot não é migration e
  não abre nenhum caminho de escrita);
- não permite escrita de qualquer espécie em produção;
- não amplia o DENY_SET nem os demais scripts da allowlist.

Wiring: selftest sobe para **13 casos** (novo `remoto+m02:snapshot` →
`ALLOW`); `MANAGED_KEYS` passa a isolar também `SUPABASE_MIGRATION_DATABASE_URL`
(credenencial legacy usada pelo wrapper `m02:v2b` — mantida fora da matriz do
guard por ser alvo de LEITURA do wrapper, não do guard; o isolamento vale para
determinismo do selftest).

## 11. Emenda #6 (2026-09-07, RAT S0 PS-01) — produtor/consumidor DP5=(b)

Ratificada em S0 (PS-01 §6) em 2026-09-07: DP5 opção (b). Sem `--out-dir`,
o layout padrão `snapshot-<data>.dump` (+ anti-sobrescrita por sequência)
permanece INALTERADO. Com `--out-dir` explícito, o produtor gera o trio
exato `dump.pgc` + `dump.pgc.sha256` (`<sha>  dump.pgc`) + `metadata.json`
com `producer:"m02:snapshot"`, `source:"production"`,
`connection_kind:"direct"`, `read_only:true`, `motivo` não vazio e
`created_at` UTC (= início da captura); trio pré-existente = exit 2
fail-closed pré-conexão, sem sobrescrever. Motivo obrigatório e recusa a
`-pooler` valem NOS DOIS modos, antes de qualquer conexão (exit 3).
Sucesso somente pós-hash.

O consumidor `snapshot-fresco` (`m02-readiness.mjs`) conserva o glob
literal `.artifacts/backup-drill/*/dump.pgc` e valida o trio: metadata
completa, valores exatos, SHA-256 do conteúdo igual ao declarado e ao
sidecar, idade `0 <= (agora - created_at) < 24h`. Data inválida/futura,
hash divergente ou artefato incompleto NUNCA produzem PASS; `mtime` não
define frescor (nem seleção, nem idade).

Limites: nada aqui relaxa hard-denies (#2/#3), kinds/janelas, a proibição
de mudar o glob, ou a regra de operar via npm. `.dump` do diretório padrão
e snapshot nativo, sozinhos, não substituem o trio do gate.

## 12. Emenda #7 (2026-09-08, C-02A) - reparo de grants e probe RLS em branch

O operador `m02:grant-repair` passa a integrar a allowlist de operações
sancionadas e o hook `prem02:grant-repair`. Ele pode escrever somente na
variável `DATABASE_RESTORE_URL` apontada a uma branch `drill-branch`; a origem
`DATABASE_ADMIN_URL` é read-only e production é hard-deny no próprio operador.
O motivo `ALLOW_REMOTE_DB` é obrigatório para execução remota e nunca contém
URL.

O operador `m02:rls-probe`, pelo hook `prem02:rls-probe`, segue o mesmo limite
para esta rodada: seed somente em `DATABASE_RESTORE_URL`, endpoint direct,
`NEON_MIGRATION_TARGET_KIND=drill-branch` e motivo não vazio. O script recusa
production e pooler antes de abrir conexão, e mascara a identidade do alvo na
evidência. A allowlist não autoriza escrita em production.

Esta emenda não relaxa os hard-denies #2/#3, não fecha o residual §42 e não
autoriza retomada após o STOP de C-02A. `PS-S5` permanece dependente de H-07
PASS e `PS-S6` vigente.
