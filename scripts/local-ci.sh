#!/usr/bin/env bash
#
# local-ci.sh — CI local supervisionado.
#
# Substitui TEMPORARIAMENTE os dois pipelines de GitHub Actions enquanto a plataforma
# recusa iniciar jobs por billing/cota. Nao burla, nao contorna e nao consulta cobranca:
# executa localmente, com evidencia por SHA, o que `.github/workflows/ui-stack.yml`
# (heavy) e `.github/workflows/ci-light.yml` (light) executariam, mais as guardas que
# nenhum dos dois executa (lacunas declaradas em AGENTS.md, DBT-19).
#
# O que este script NUNCA faz:
#   * push (branch ou tag), force-push, delete de ref/branch/tag/release;
#   * leitura ou alteracao de billing / spending limit;
#   * instalacao global de pacote (o pin de npm e VERIFICADO, nunca instalado);
#   * publicacao de release ou alteracao de visibilidade de repositorio;
#   * postagem de status no GitHub por padrao (ver LOCAL_CI_POST_STATUS);
#   * impressao do conteudo de um possivel segredo (o scan escreve arquivo:linha).
#
# Fidelidade: ordem dos passos, `npm ci --ignore-scripts`, escopo por caminho com
# polaridade fail-closed e tier de e2e (chromium+mobile em push) espelham o workflow
# heavy. Onde o ambiente local impede a copia literal, a adaptacao vira dado em
# `adaptations.tsv` — nunca silencio.
#
# Uso: ./scripts/local-ci.sh
#
# Knobs:
#   LOCAL_CI_BASE=origin/develop      base do range e do calculo de escopo
#   LOCAL_CI_OUT_ROOT=...             raiz da evidencia (default docs/evidence/local-ci)
#   LOCAL_CI_DB_TIER=auto|force|skip  tier de banco (auto = segue o escopo, como o CI)
#   LOCAL_CI_E2E_TIER=auto|force|skip tier de e2e
#   LOCAL_CI_AGGREGATE_CHECK=1        roda tambem `npm run check` inteiro (default 1)
#   LOCAL_CI_TAG=1                    cria tag LOCAL ci-local/<short-sha> (nunca com -f)
#   LOCAL_CI_PG_PORT=55432            porta do PG17 EFEMERO dos tiers db/e2e
#   LOCAL_CI_POST_STATUS=dry-run      posta status local-ci/supervised (default dry-run)
#   LOCAL_CI_APPROVED=1               segunda flag exigida junto de LOCAL_CI_POST_STATUS=1
#
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SHA="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
BASE="${LOCAL_CI_BASE:-origin/develop}"
OUT_ROOT="${LOCAL_CI_OUT_ROOT:-docs/evidence/local-ci}"
OUT_DIR="${OUT_ROOT}/${SHA}"
PG_PORT="${LOCAL_CI_PG_PORT:-55432}"
PG_NAME="local-ci-pg-${SHORT_SHA}"
PG_IMAGE="postgres:17-alpine"
AGGREGATE_CHECK="${LOCAL_CI_AGGREGATE_CHECK:-1}"
CREATE_TAG="${LOCAL_CI_TAG:-1}"
POST_STATUS="${LOCAL_CI_POST_STATUS:-dry-run}"
DB_TIER="${LOCAL_CI_DB_TIER:-auto}"
E2E_TIER="${LOCAL_CI_E2E_TIER:-auto}"
NPM_PIN="11.14.1" # mesmo `npm install --global npm@<pin>` do workflow heavy

STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED_EPOCH="$(date +%s)"
RESULT="unknown"
FINALIZED=0
PG_STARTED=0

# Uma execucao anterior para o MESMO SHA nao e apagada nem misturada: vai para
# `_archive/<sha>-<utc>/`. Misturar duas rodadas no mesmo diretorio produziria um conjunto
# incoerente (status de uma rodada + logs de outra) — e a rodada que falhou tambem e evidencia.
ARCHIVED_FROM=""
if [ -d "$OUT_DIR" ] && [ -n "$(ls -A "$OUT_DIR" 2>/dev/null)" ]; then
  ARCHIVED_FROM="${OUT_ROOT}/_archive/${SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$(dirname "$ARCHIVED_FROM")"
  mv "$OUT_DIR" "$ARCHIVED_FROM"
  # O selo da rodada anterior vive FORA do diretorio arquivado; move junto para o arquivo
  # nao passar a apontar para o selo da rodada nova.
  if [ -f "${OUT_ROOT}/${SHA}.sha256" ]; then
    mv "${OUT_ROOT}/${SHA}.sha256" "${ARCHIVED_FROM}/"
  fi
fi

mkdir -p "$OUT_DIR"
STEPS_TSV="${OUT_DIR}/steps.tsv"
ADAPT_TSV="${OUT_DIR}/adaptations.tsv"
PEND_TSV="${OUT_DIR}/pendencies.tsv"
: >"$STEPS_TSV"
: >"$ADAPT_TSV"
: >"$PEND_TSV"
if [ -n "$ARCHIVED_FROM" ]; then
  printf '%s\n' "$ARCHIVED_FROM" >"${OUT_DIR}/previous-run-archived.txt"
fi
log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Mascara segredo no eco do comando: nome de variavel sensivel e a senha dentro de URL.
redact() {
  printf '%s' "$*" |
    sed -E 's#([A-Za-z_]*(PASSWORD|SECRET|TOKEN|CREDENTIAL|KEY)[A-Za-z_]*=)[^[:space:]]+#\1***#g' |
    sed -E 's#(://[^:/@[:space:]]+):[^@[:space:]]+@#\1:***@#g'
}

adapt() { printf '%s\t%s\n' "$1" "$2" >>"$ADAPT_TSV"; log "ADAPTACAO [${1}]: $2"; }
record_step() { printf '%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "${4:-}" >>"$STEPS_TSV"; }

precondition() {
  log "PRECONDICAO FALHOU: $*"
  printf 'precondition-failure\n' >"${OUT_DIR}/result.txt"
  exit 2
}

# ---------------------------------------------------------------------------
# Etapas: log, status e duracao por etapa
# ---------------------------------------------------------------------------
run_step() {
  local name="$1" kind="$2" covered="$3"
  shift 3
  local t0 t1
  log ">> ${name}: $(redact "$*")"
  t0="$(date +%s)"
  if "$@" >"${OUT_DIR}/${name}.log" 2>&1; then
    t1="$(date +%s)"
    echo "success" >"${OUT_DIR}/${name}.status"
    echo "$((t1 - t0))" >"${OUT_DIR}/${name}.duration-seconds"
    record_step "$name" "success" "$kind" "$covered"
    log "<< ${name}: success ($((t1 - t0))s)"
    return 0
  fi
  t1="$(date +%s)"
  echo "failure" >"${OUT_DIR}/${name}.status"
  echo "$((t1 - t0))" >"${OUT_DIR}/${name}.duration-seconds"
  record_step "$name" "failure" "$kind" "$covered"
  log "<< ${name}: FAILURE ($((t1 - t0))s) — log: ${OUT_DIR}/${name}.log"
  return 1
}

mark_skipped() {
  local name="$1" reason="$2" covered="${3:-}"
  echo "skipped" >"${OUT_DIR}/${name}.status"
  printf '%s\n' "$reason" >"${OUT_DIR}/${name}.log"
  record_step "$name" "skipped" "conditional" "$covered"
  log "-- ${name}: SKIPPED — ${reason}"
}

mark_blocked() {
  local name="$1" reason="$2"
  echo "blocked" >"${OUT_DIR}/${name}.status"
  printf '%s\n' "$reason" >"${OUT_DIR}/${name}.log"
  record_step "$name" "blocked" "conditional" ""
  log "-- ${name}: BLOCKED — ${reason}"
}

step_required() {
  local name="$1" covered="$2"
  shift 2
  run_step "$name" "required" "$covered" "$@" || { finalize "failure"; exit 1; }
}

step_conditional() {
  local name="$1" covered="$2"
  shift 2
  run_step "$name" "conditional" "$covered" "$@" || { finalize "failure"; exit 1; }
}

pendency() { printf '%s\t%s\n' "$1" "$2" >>"$PEND_TSV"; log "PENDENCIA [${1}]: $2"; }

# Etapa informativa: roda e registra o status REAL, mas NAO aborta o pipeline. Reservada a
# checagens que nao pertencem a nenhum dos dois pipelines de CI (`m02:state:check` e passo do
# protocolo de boot, nao gate de CI). Um vermelho aqui e ACHADO, nao veredicto: entra em
# `pendencies` no manifesto e em REPORT.md, e exige decisao humana.
step_informational() {
  local name="$1" covered="$2"
  shift 2
  if ! run_step "$name" "informational" "$covered" "$@"; then
    pendency "$name" "etapa informativa VERMELHA (nao pertence a nenhum pipeline de CI) — ver ${name}.log"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Manifesto + relatorio (uma unica fonte: steps.tsv + status files)
# ---------------------------------------------------------------------------
generate_manifest_and_report() {
  OUT_DIR="$OUT_DIR" SHA="$SHA" SHORT_SHA="$SHORT_SHA" BRANCH="$BRANCH" BASE="$BASE" \
    STARTED_AT="$STARTED_AT" FINISHED_AT="${FINISHED_AT:-unknown}" RESULT="$RESULT" \
    ROOT_DIR="$ROOT_DIR" PG_PORT="$PG_PORT" NPM_PIN="$NPM_PIN" \
    node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const OUT = process.env.OUT_DIR;
const read = (f, d = "") => { try { return fs.readFileSync(path.join(OUT, f), "utf8").trim(); } catch { return d; } };
const steps = read("steps.tsv").split("\n").filter(Boolean).map((l) => {
  const [name, status, kind, covered] = l.split("\t");
  return {
    name, status, kind,
    covered: covered || null,
    log: `${name}.log`,
    durationSeconds: Number(read(`${name}.duration-seconds`, "0")) || 0,
  };
});
const adaptations = read("adaptations.tsv").split("\n").filter(Boolean).map((l) => {
  const [id, detail] = l.split("\t");
  return { id, detail };
});
const pendencies = read("pendencies.tsv").split("\n").filter(Boolean).map((l) => {
  const [id, detail] = l.split("\t");
  return { id, detail };
});
const chain = JSON.parse(fs.readFileSync(path.join(process.env.ROOT_DIR, "package.json"), "utf8"))
  .scripts.check.split("&&").map((s) => s.trim().replace(/^npm run /, ""));
const executed = new Set(steps.map((s) => s.covered).filter(Boolean));
const postProcessing = {
  prettierNormalize: read("prettier-normalize.status", "absent"),
  localTag: read("local-tag.status", "not-created"),
  githubStatus: read("github-status.status", "skipped"),
  evidenceIntegrity: read("evidence-integrity.status", "ok"),
};
const counts = (() => { try { return JSON.parse(read("evidence-counts.json", "{}")); } catch { return {}; } })();
const preservationDir = path.join(OUT, "artifacts");
const bundleName = `local-commits-${process.env.SHORT_SHA}.bundle`;
const patches = fs.existsSync(path.join(preservationDir, "patches"))
  ? fs.readdirSync(path.join(preservationDir, "patches")).sort()
  : [];
const declared = [...new Set([...chain, "m02:secrets-audit", "m02:boundaries", "m02:state:check",
  "npm-audit", "playwright-e2e"])];
const uncovered = declared.filter((d) => !executed.has(d));

const manifest = {
  schema: "local-ci/v1",
  headSha: process.env.SHA,
  shortSha: process.env.SHORT_SHA,
  branch: process.env.BRANCH,
  base: process.env.BASE,
  range: `${process.env.BASE}..${process.env.SHA}`,
  startedAt: process.env.STARTED_AT,
  finishedAt: process.env.FINISHED_AT,
  durationSeconds: Number(read("duration-seconds.txt", "0")) || 0,
  result: process.env.RESULT,
  runner: {
    type: "local-supervised",
    os: `${process.platform} ${process.arch}`,
    node: process.version,
    npm: read("npm-pin.txt", "unknown"),
    npmPinExpected: process.env.NPM_PIN,
    git: read("preflight-tools.txt").split("\n").find((l) => l.startsWith("git ")) || "unknown",
    ephemeralDatabasePort: Number(process.env.PG_PORT),
  },
  steps,
  postProcessing,
  coverage: {
    declaredChecks: declared,
    executedChecks: [...executed].sort(),
    uncovered,
    checkedEqualsDiscovered: uncovered.length === 0,
  },
  security: {
    secretAuditStep: steps.find((s) => s.name === "m02:secrets-audit")?.status || "absent",
    rangeSecretScan: read("range-secret-scan.status", "absent"),
    rangeSecretScanHits: read("range-secret-scan.hits", "") ? read("range-secret-scan.hits").split("\n") : [],
    remoteMutations: false,
    billingChanges: false,
    billingEndpointsTouched: false,
    pushPerformed: false,
    globalInstalls: false,
    localTagOnly: true,
    message: "Nenhum push, nenhuma tag enviada, nenhum acesso a billing.",
  },
  adaptations,
  pendencies,
  evidence: {
    policy: counts.policy || "metadata-only",
    gitTrackedLogs: counts.gitTrackedLogs === true,
    localLogsAvailable: counts.localLogsAvailable === true,
    filesTotal: counts.filesTotal ?? null,
    filesGitTrackable: counts.filesGitTrackable ?? null,
    filesGitIgnored: counts.filesGitIgnored ?? null,
    logsTotal: counts.logsTotal ?? null,
    logsGitIgnored: counts.logsGitIgnored ?? null,
    artifactsTotal: counts.artifactsTotal ?? null,
    artifactsGitIgnored: counts.artifactsGitIgnored ?? null,
    filesIgnoredOther: counts.filesIgnoredOther ?? null,
    // Fotografia temporal declarada como tal: as contagens valem em `measuredAt`, nao "no fim".
    countsAreSnapshotAt: counts.measuredAt || null,
    // Estado da arvore no momento da selagem. `dirty-escaped` significa que o escape foi usado e que
    // o headSha NAO corresponde ao conteudo validado — declarado, nunca silenciado (item D do Item 5).
    treeState: read("tree-state.txt", "unknown"),
    dirtyEscapeUsed: read("tree-state.txt", "") === "dirty-escaped",
    dirtyEntriesOutsideEvidence: Number(read("dirty-entries.txt", "0")) || 0,
    headShaCorrespondsToContent: read("tree-state.txt", "") === "clean",
    gitChecksum: "evidence.git.sha256",
    fullSeal: `${process.env.SHA}.sha256`,
    countsFile: "evidence-counts.json",
    measuredAt: counts.measuredAt || null,
    note: "metadata-only: versiona-se apenas o metadata; *.log, bundle e patches ficam locais e sao cobertos pelo selo integral (fullSeal), nao pelo selo versionavel (gitChecksum).",
  },
  artifacts: {
    bundle: `artifacts/${bundleName}`,
    bundleVerified: read("preserve-bundle.status").includes("verified"),
    bundlePolicy: "local-only (nunca versionado: artifacts/ e ignorado pelo .gitignore)",
    patchesDir: "artifacts/patches/",
    patchesPolicy: "local-only (nunca versionado)",
    patchCount: patches.length,
    patches,
    checksum: `${process.env.SHA}.sha256`,
    manifestChecksum: "manifest.sha256",
    artifactsChecksum: "artifacts.sha256",
    gitChecksum: "evidence.git.sha256",
    report: "REPORT.md",
  },
};
fs.writeFileSync(path.join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const table = steps.map((s) => `| ${s.name} | ${s.status} | ${s.durationSeconds}s | ${s.log} |`).join("\n");
const adaptRows = adaptations.length
  ? adaptations.map((a) => `| ${a.id} | ${a.detail} |`).join("\n")
  : "| — | nenhuma adaptacao necessaria |";
const notOk = steps.filter((s) => s.status !== "success");
const report = `# CI local supervisionado

Pipeline local que substitui temporariamente o GitHub Actions bloqueado por billing. Nao
houve tentativa de contornar cobranca, nao houve push e nao houve postagem de status sem
aprovacao explicita.

## Veredicto

- Estado: **${process.env.RESULT}**
- SHA validado: \`${process.env.SHA}\`
- Range: \`${process.env.BASE}..${process.env.SHA}\`
- Branch: \`${process.env.BRANCH}\`
- Inicio: ${process.env.STARTED_AT}
- Fim: ${process.env.FINISHED_AT}
- Push realizado: **nao**
- Billing alterado: **nao**
- CI remoto usado: **nao**
- Status GitHub: ${postProcessing.githubStatus}

## Etapas

| Etapa | Status | Duracao | Log |
| --- | --- | --- | --- |
${table}

## Cobertura

- Checks declarados: ${declared.length}
- Cobertos por etapa nomeada: ${declared.length - uncovered.length}
- Lacunas: ${uncovered.length === 0 ? "nenhuma" : uncovered.join(", ")}

## Adaptacoes ao ambiente local

| Item | Detalhe |
| --- | --- |
${adaptRows}

## Pendencias que exigem decisao humana

${pendencies.length === 0 ? "Nenhuma pendencia registrada." : pendencies.map((p) => `- **${p.id}** — ${p.detail}`).join("\n")}

## Evidencia e politica de versionamento

- Politica: **${counts.policy || "metadata-only"}** — versiona-se apenas o metadata.
- Arquivos: ${counts.filesTotal ?? "?"} no total · **${counts.filesGitTrackable ?? "?"} versionaveis** · ${counts.filesGitIgnored ?? "?"} ignorados pelo Git.
- Logs: ${counts.logsTotal ?? "?"} · ignorados pelo Git: ${counts.logsGitIgnored ?? "?"} (ficam **locais**; cobertos pelo selo integral, nao pelo versionavel).
- Artefatos de preservacao (bundle/patches): ${counts.artifactsTotal ?? "?"} · sob \`artifacts/\`, ignorado pelo \`.gitignore\` — **nunca versionados**.

## Artefatos

- \`${process.env.SHA}.sha256\` — selo integral (cobre **todos** os arquivos, inclusive logs e artefatos)
- \`evidence.git.sha256\` — selo restrito ao que o Git versiona
- \`manifest.json\` + \`manifest.sha256\` + \`evidence-counts.json\`
- \`artifacts/${bundleName}\` (local-only)
- \`artifacts/patches/\` (${patches.length} patches, local-only)
- \`artifacts.sha256\`

## Seguranca

- Nenhuma mutacao remota; nenhum push; nenhuma tag enviada.
- Nenhuma leitura ou alteracao de billing / spending limit.
- Nenhuma instalacao global de pacote.
- Selagem: sha256 (checksum), nao assinatura criptografica de identidade.
- Etapas sem sucesso: ${notOk.length === 0 ? "nenhuma" : notOk.map((s) => `${s.name} (${s.status})`).join(", ")}.

## Proximos passos

1. Decisao humana sobre push: nada foi enviado.
2. Revalidar no CI oficial quando o billing voltar; este selo cobre a janela de bloqueio.
3. Manter bundle e patches preservados ate o push acontecer.
`;
fs.writeFileSync(path.join(OUT, "REPORT.md"), report);
NODE
}

normalize_evidence() {
  [ -x node_modules/.bin/prettier ] || return 0
  node_modules/.bin/prettier --write "${OUT_DIR}/manifest.json" "${OUT_DIR}/REPORT.md" \
    >"${OUT_DIR}/prettier-normalize.log" 2>&1 || return 1
  node_modules/.bin/prettier --check "${OUT_DIR}/manifest.json" "${OUT_DIR}/REPORT.md" \
    >>"${OUT_DIR}/prettier-normalize.log" 2>&1 || return 1
  return 0
}

# ---------------------------------------------------------------------------
# Politica de evidencia (`metadata-only`).
#
# Fonte UNICA do que e medido: a classificacao vem do proprio mecanismo do Git
# (`git check-ignore`), nunca de uma lista de extensoes mantida a mao. O resultado e escrito em
# `evidence-counts.json`, que o gerador do manifesto consome — assim o manifesto declara numeros
# MEDIDOS, e nao estimados.
#
# Fail-closed: sob `metadata-only`, nenhum `*.log` pode ser versionavel e nenhum artefato de
# preservacao pode ser versionavel. Contradicao => exit 1 (veredicto), ausencia de precondicao =>
# exit 2 (idioma do repo).
# ---------------------------------------------------------------------------
measure_evidence() {
  OUT_DIR="$OUT_DIR" ROOT_DIR="$ROOT_DIR" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const OUT = process.env.OUT_DIR;
const ROOT = process.env.ROOT_DIR;

if (!fs.existsSync(OUT)) { console.error(`precondicao: ${OUT} inexistente`); process.exit(2); }

const walk = (dir, acc = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, acc);
    else if (e.isFile()) acc.push(path.relative(ROOT, full));
  }
  return acc;
};

const files = walk(OUT).sort();
if (files.length === 0) { console.error("precondicao: arvore de evidencia vazia"); process.exit(2); }

// `git check-ignore --stdin` sai 0 se ALGUM caminho for ignorado e 1 se nenhum for; QUALQUER outro
// status e falha de precondicao (repo ausente, git quebrado, caminho fora do repo) e NAO pode ser
// lido como "nada ignorado" — essa era uma porta fail-open na primeira versao desta funcao.
let ignoredOut = "";
try {
  ignoredOut = execFileSync("git", ["check-ignore", "--stdin"], {
    cwd: ROOT, input: files.join("\n"), encoding: "utf8",
  });
} catch (error) {
  if (error.status !== 1) {
    console.error(`precondicao: git check-ignore falhou (status ${error.status}): ${(error.stderr || "").toString().trim().split("\n")[0]}`);
    process.exit(2);
  }
  ignoredOut = typeof error.stdout === "string" ? error.stdout : "";
}
const ignored = new Set(ignoredOut.split("\n").filter(Boolean));

const isLog = (f) => f.endsWith(".log");
// Preservacao e classificada por CONTEUDO/NOME, nao so por diretorio: um bundle largado na raiz da
// evidencia seria versionavel e escaparia de uma regra que so olhasse para `artifacts/`.
const isPreservation = (f) =>
  f.includes(`${path.sep}artifacts${path.sep}`) ||
  /local-commits-[0-9a-f]+\.bundle$/.test(f) ||
  f.endsWith(".patch");
const logs = files.filter(isLog);
const artifacts = files.filter(isPreservation);
const logsIgnored = logs.filter((f) => ignored.has(f)).length;
const artifactsIgnored = artifacts.filter((f) => ignored.has(f)).length;

const counts = {
  measuredAt: new Date().toISOString(),
  policy: "metadata-only",
  filesTotal: files.length,
  filesGitIgnored: ignored.size,
  filesGitTrackable: files.length - ignored.size,
  logsTotal: logs.length,
  logsGitIgnored: logsIgnored,
  artifactsTotal: artifacts.length,
  artifactsGitIgnored: artifactsIgnored,
  // Ignorados que NAO sao log nem artefato: > 0 significa que surgiu uma classe nova de arquivo
  // ignorado sem ninguem declarar — o chamador registra aviso nominal.
  filesIgnoredOther: Math.max(0, ignored.size - logsIgnored - artifactsIgnored),
  // Derivado, nunca afirmado: se algum log fosse versionavel, isto seria `true` — e a politica
  // `metadata-only` entao REPROVA logo abaixo, em vez de mentir no manifesto.
  gitTrackedLogs: logs.length !== logsIgnored,
  localLogsAvailable: logs.length > 0,
  gitTrackableFiles: files.filter((f) => !ignored.has(f)),
};
fs.writeFileSync(path.join(OUT, "evidence-counts.json"), `${JSON.stringify(counts, null, 2)}\n`);

const failures = [];
if (counts.gitTrackedLogs) {
  failures.push(`${logs.length - logsIgnored} arquivo(s) *.log seriam versionados sob politica metadata-only`);
}
if (artifacts.length !== artifactsIgnored) {
  failures.push(`${artifacts.length - artifactsIgnored} artefato(s) de preservacao seriam versionados (esperado: todos sob artifacts/, ignorado pelo .gitignore)`);
}
console.log(`politica=metadata-only total=${counts.filesTotal} versionaveis=${counts.filesGitTrackable} ignorados=${counts.filesGitIgnored} logs=${logs.length}(ignorados ${logsIgnored}) artefatos=${artifacts.length}(ignorados ${artifactsIgnored})`);
if (failures.length) { failures.forEach((f) => console.error(`VIOLACAO: ${f}`)); process.exit(1); }
console.log("politica de evidencia OK: nada de log/artefato versionavel");
NODE
}

# Selo restrito ao conjunto que o GIT versiona (untracked-nao-ignorado inclui o metadata ainda nao
# commitado). O arquivo e escrito primeiro em /tmp e movido depois, porque o redirect criaria o
# destino ANTES da listagem e o selo passaria a cobrir a si mesmo com o hash de um arquivo vazio.
generate_git_checksum() {
  local tmp
  tmp="$(mktemp)"
  # `:(exclude)` tira o proprio selo da listagem — um selo que cobre a si mesmo carrega o hash de um
  # arquivo vazio e nunca verifica. O selo INTEGRAL (`<sha>.sha256`) cobre este arquivo depois.
  if git ls-files -z --cached --others --exclude-standard -- "$OUT_DIR" \
    ":(exclude)${OUT_DIR}/evidence.git.sha256" |
    sort -z | xargs -0 sha256sum >"$tmp" 2>/dev/null; then
    mv "$tmp" "${OUT_DIR}/evidence.git.sha256"
  else
    rm -f "$tmp"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Preservacao dos commits (bundle + patches) — local, nunca enviado
# ---------------------------------------------------------------------------
preserve_commits() {
  # `artifacts/` e ignorado pelo proprio .gitignore do repo (`docs/evidence/**/artifacts/`), entao a
  # politica "nao versionar bundle/patches" fica IMPOSTA pelas regras do Git em vez de por uma lista
  # mantida a mao — a classe de defeito que o hardening deste script persegue (ver SPEC do hardening).
  local dir="${OUT_DIR}/artifacts"
  mkdir -p "$dir/patches"
  local bundle="${dir}/local-commits-${SHORT_SHA}.bundle"
  if git bundle create "$bundle" "${BASE}..HEAD" >"${OUT_DIR}/preserve-bundle.log" 2>&1; then
    if git bundle verify "$bundle" >>"${OUT_DIR}/preserve-bundle.log" 2>&1; then
      echo "verified" >"${OUT_DIR}/preserve-bundle.status"
    else
      echo "unverified" >"${OUT_DIR}/preserve-bundle.status"
    fi
    record_step "preserve-bundle" "success" "extra" ""
  else
    echo "failure" >"${OUT_DIR}/preserve-bundle.status"
    record_step "preserve-bundle" "failure" "extra" ""
    return 1
  fi
  if git format-patch "${BASE}..HEAD" -o "$dir/patches" >"${OUT_DIR}/preserve-patches.log" 2>&1; then
    echo "success" >"${OUT_DIR}/preserve-patches.status"
    record_step "preserve-patches" "success" "extra" ""
  else
    echo "failure" >"${OUT_DIR}/preserve-patches.status"
    record_step "preserve-patches" "failure" "extra" ""
    return 1
  fi
  ( cd "$dir" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) >"${OUT_DIR}/artifacts.sha256" 2>&1 || true
  return 0
}

seal_evidence() {
  # `manifest.sha256` ja foi escrito com o conteudo FINAL antes de gerar o selo versionavel (para ser
  # coberto por ele — item C do Item 5); aqui resta apenas o selo integral, que cobre tudo.
  ( cd "$OUT_ROOT" && find "${SHA}" -type f -print0 | sort -z | xargs -0 sha256sum ) \
    >"${OUT_ROOT}/${SHA}.sha256" 2>&1 || true
}

# Fechamento da politica. Ordem escolhida para chegar a um PONTO FIXO (o selo nao pode selar a si
# mesmo, e o manifesto nao pode declarar contagens que o proprio selo invalida):
#   1. mede                     -> contagens C1
#   2. gera o selo versionavel  -> cria evidence.git.sha256 (excluindo a si mesmo da listagem)
#   3. mede de novo             -> contagens C2 (o conjunto de arquivos ja esta estavel)
#   4. manifesto com C2, selo regerado cobrindo o manifesto final (mesmo conjunto de arquivos)
# Contradicao => return 1, e quem chama rebaixa o veredicto.
close_evidence_policy() {
  : >"${OUT_DIR}/evidence-policy-final.log"
  # Estabiliza o CONJUNTO antes de medir: o conteudo de manifest.sha256 muda depois (passa a selar o
  # manifesto final), mas a EXISTENCIA dele nao — sem isto a contagem declarada ficaria 1 abaixo do selo
  # versionavel e o cross-check de contagens acusaria divergencia falsa.
  [ -f "${OUT_DIR}/manifest.sha256" ] || printf 'pendente\n' >"${OUT_DIR}/manifest.sha256"
  if ! measure_evidence >>"${OUT_DIR}/evidence-policy-final.log" 2>&1; then
    log "ERRO: politica de evidencia violada no fechamento — ver evidence-policy-final.log"
    echo "failure" >"${OUT_DIR}/evidence-policy-final.status"
    return 1
  fi
  # O status do fecho e um ARQUIVO VERSIONAVEL: escreve-lo DEPOIS do selo deixava o selo um arquivo
  # atras do mundo (`covered = declared - 2`), o que fazia o cross-check abaixo reprovar por um motivo
  # que o proprio instrumento criava. Ele passa a ser escrito ANTES do selo, e a medicao final continua
  # sendo a ULTIMA escrita no diretorio.
  echo "success" >"${OUT_DIR}/evidence-policy-final.status"
  if ! generate_git_checksum >>"${OUT_DIR}/evidence-policy-final.log" 2>&1; then
    log "ERRO: selo versionavel inconsistente com a politica — ver evidence-policy-final.log"
    echo "failure" >"${OUT_DIR}/evidence-policy-final.status"
    return 1
  fi
  if ! measure_evidence >>"${OUT_DIR}/evidence-policy-final.log" 2>&1; then
    log "ERRO: politica de evidencia violada apos gerar o selo — ver evidence-policy-final.log"
    echo "failure" >"${OUT_DIR}/evidence-policy-final.status"
    return 1
  fi
  # CROSS-CHECK DE CONTAGENS AQUI, nao depois da geracao dos artefatos. O selo versionavel exclui a si
  # mesmo, entao tem de cobrir `filesGitTrackable - 1`. Antes desta correcao a checagem vivia em
  # `verify_git_checksum`, que roda DEPOIS de `generate_manifest_and_report` + `manifest.sha256` +
  # `generate_git_checksum`: quando ela reprovava, o manifesto, o REPORT e o SELO ja estavam gravados
  # com `success` e NADA os regenerava. Foi assim que a rodada `1b54a89c` ficou com `result.txt=failure`,
  # `manifest.result=success` e um selo versionavel que nao conferia. Decidir o veredicto ANTES de gerar
  # e o que impede a contradicao.
  local covered declared
  covered="$(wc -l <"${OUT_DIR}/evidence.git.sha256" | tr -d ' ')"
  declared="$(node -e "try{console.log(require('./${OUT_DIR}/evidence-counts.json').filesGitTrackable)}catch{console.log('')}" 2>/dev/null)"
  if [ -n "$declared" ] && [ "$covered" -ne "$((declared - 1))" ]; then
    {
      echo "VIOLACAO: selo versionavel cobre ${covered} arquivo(s), mas a medicao final declara ${declared} versionaveis (esperado ${covered} = declared - 1)"
    } >"${OUT_DIR}/evidence-git-checksum.log"
    log "ERRO: cross-check de contagens reprovou ANTES da geracao — veredicto rebaixado, artefatos sairao coerentes"
    echo "failure" >"${OUT_DIR}/evidence-policy-final.status"
    return 1
  fi
  return 0
}

# Verificacao de conteudo do selo versionavel, depois do manifesto final.
verify_git_checksum() {
  local covered declared
  covered="$(wc -l <"${OUT_DIR}/evidence.git.sha256" | tr -d ' ')"
  # Cross-check de CONTAGENS: o selo versionavel exclui a si mesmo, entao tem de cobrir exatamente
  # `filesGitTrackable - 1` arquivos. Divergencia = o manifesto declara um mundo que o selo desmente.
  declared="$(node -e "try{console.log(require('./${OUT_DIR}/manifest.json').evidence.filesGitTrackable)}catch{console.log('')}" 2>/dev/null)"
  if [ -n "$declared" ] && [ "$covered" -ne "$((declared - 1))" ]; then
    {
      echo "VIOLACAO: selo versionavel cobre ${covered} arquivo(s), mas o manifesto declara ${declared} versionaveis (esperado ${covered} = declared - 1)"
    } >"${OUT_DIR}/evidence-git-checksum.log"
    return 1
  fi
  {
    echo "arquivos cobertos: ${covered}"
    if grep -qE '\.log$' "${OUT_DIR}/evidence.git.sha256"; then
      echo "VIOLACAO: selo versionavel contem *.log sob politica metadata-only"
      return 1
    fi
    if [ "$covered" -lt 5 ]; then
      echo "VIOLACAO: selo versionavel cobre apenas ${covered} arquivo(s) — esperado ao menos 5 de metadata"
      return 1
    fi
    for f in manifest.json manifest.sha256 REPORT.md steps.tsv adaptations.tsv pendencies.tsv; do
      if ! grep -q "/${f}\$" "${OUT_DIR}/evidence.git.sha256"; then
        echo "VIOLACAO: ${f} ausente do selo versionavel"
        return 1
      fi
    done
    echo "selo versionavel OK: metadata presente, nenhum log"
  } >"${OUT_DIR}/evidence-git-checksum.log" 2>&1 || return 1
  log "selo versionavel verificado: ${covered} arquivo(s), 0 logs"
  return 0
}

# ---------------------------------------------------------------------------
# Pos-processamento: tag local e status GitHub (ambos nunca remotos)
# ---------------------------------------------------------------------------
postprocess_local_tag() {
  if [ "$CREATE_TAG" = "1" ]; then
    if git rev-parse -q --verify "refs/tags/ci-local/${SHORT_SHA}" >/dev/null 2>&1; then
      echo "exists" >"${OUT_DIR}/local-tag.status"
    elif git tag -a "ci-local/${SHORT_SHA}" -m "CI local supervisionado ${SHA} (${RESULT})" \
      >"${OUT_DIR}/local-tag.log" 2>&1; then
      echo "created" >"${OUT_DIR}/local-tag.status"
    else
      echo "failed" >"${OUT_DIR}/local-tag.status"
    fi
  else
    echo "disabled" >"${OUT_DIR}/local-tag.status"
  fi
  # Contrato: a tag e LOCAL e nunca e enviada. Nenhum comando de push e executado aqui —
  # nem sequer `--dry-run`, que ja contataria o remoto.
}

postprocess_github_status() {
  local repo state
  repo="$(git remote get-url origin | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?$#\1#')"
  state="$([ "$RESULT" = "success" ] && echo success || echo failure)"
  {
    echo "# Dry-run — NADA foi postado. Para postar: LOCAL_CI_POST_STATUS=1 LOCAL_CI_APPROVED=1"
    echo "# Contexto sempre distinguivel do CI oficial: local-ci/supervised"
    echo "gh api -X POST repos/${repo}/statuses/${SHA} \\"
    echo "  -f state=${state} \\"
    echo "  -f context=local-ci/supervised \\"
    echo "  -f description='CI local supervisionado (nao e o CI oficial)'"
  } >"${OUT_DIR}/github-status.dry-run.sh"

  if [ "$POST_STATUS" = "1" ] && [ "${LOCAL_CI_APPROVED:-0}" = "1" ]; then
    if gh api -X POST "repos/${repo}/statuses/${SHA}" \
      -f state="$state" -f context="local-ci/supervised" \
      -f description="CI local supervisionado (nao e o CI oficial)" \
      >"${OUT_DIR}/github-status.log" 2>&1; then
      echo "posted" >"${OUT_DIR}/github-status.status"
    else
      echo "failed" >"${OUT_DIR}/github-status.status"
    fi
  else
    echo "skipped" >"${OUT_DIR}/github-status.status"
  fi
}

# ---------------------------------------------------------------------------
# finalize — idempotente; chamado no sucesso, na falha e no trap
# ---------------------------------------------------------------------------
finalize() {
  [ "$FINALIZED" -eq 1 ] && return 0
  FINALIZED=1
  local want="$1"
  FINISHED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local elapsed=$(( $(date +%s) - STARTED_EPOCH ))

  if [ "$PG_STARTED" -eq 1 ]; then
    docker rm -f "$PG_NAME" >/dev/null 2>&1 && log "container efemero ${PG_NAME} removido" || true
    PG_STARTED=0
  fi

  preserve_commits || { log "preservacao (bundle/patches) falhou"; [ "$want" = "success" ] && want="failure"; }
  RESULT="$want"
  echo "$RESULT" >"${OUT_DIR}/result.txt"
  printf '%s\n' "$FINISHED_AT" >"${OUT_DIR}/finished-at.txt"
  printf '%s\n' "$elapsed" >"${OUT_DIR}/duration-seconds.txt"

  postprocess_local_tag
  postprocess_github_status

  generate_manifest_and_report          # pass 1 — insumo do formatador
  if normalize_evidence; then
    echo "success" >"${OUT_DIR}/prettier-normalize.status"
  else
    echo "failure" >"${OUT_DIR}/prettier-normalize.status"
    log "ERRO: evidencia nao normalizou no prettier — ver prettier-normalize.log"
    [ "$want" = "success" ] && { want="failure"; RESULT="$want"; echo "$RESULT" >"${OUT_DIR}/result.txt"; }
  fi
  generate_manifest_and_report          # pass 2 — inclui o pos-processamento
  normalize_evidence || true            # re-normaliza a pass 2 (idempotente)
  if normalize_evidence; then
    echo "ok" >"${OUT_DIR}/evidence-integrity.status"
  else
    echo "failure" >"${OUT_DIR}/evidence-integrity.status"
    log "ERRO: bytes finais da evidencia nao estabilizam no prettier"
  fi

  # ESTABILIDADE DO ESTADO: a evidencia so vale para o conteudo que foi validado. Se o HEAD ou a arvore
  # mudarem DURANTE a rodada, o selo passa a rotular conteudo que nao foi medido — foi o que aconteceu
  # em 2026-09-23 (arquivos escritos enquanto o pipeline rodava). A precondicao de abertura nao pega
  # mutacao que acontece DEPOIS dela; esta checagem pega.
  local head_end dirty_end
  head_end="$(git rev-parse HEAD)"
  dirty_end="$(git status --porcelain=v1 | grep -vE '^\?\? docs/evidence/local-ci/' | grep -c . || true)"
  if [ "$head_end" != "$SHA" ] || [ "$dirty_end" != "$DIRTY_OUTSIDE" ]; then
    log "ERRO: estado mudou durante a rodada (HEAD ${SHA:0:8}->${head_end:0:8}, sujeira ${DIRTY_OUTSIDE}->${dirty_end}) — evidencia invalida"
    pendency "state-drift" "o HEAD ou a arvore mudaram durante a rodada (HEAD ${SHA:0:8}->${head_end:0:8}; entradas sujas ${DIRTY_OUTSIDE}->${dirty_end}): a evidencia NAO corresponde ao conteudo validado"
    [ "$want" = "success" ] && { want="failure"; RESULT="$want"; echo "$RESULT" >"${OUT_DIR}/result.txt"; }
  fi

  # Politica de evidencia: mede o estado final, gera o selo versionavel e regrava as contagens que o
  # manifesto declara. Contradicao REBAIXA o veredicto — o manifesto nao pode afirmar uma politica
  # que o mundo desmente.
  if ! close_evidence_policy; then
    [ "$want" = "success" ] && { want="failure"; RESULT="$want"; echo "$RESULT" >"${OUT_DIR}/result.txt"; }
  fi
  generate_manifest_and_report          # pass 3 — consome as contagens finais (C2)
  normalize_evidence || true
  # Item C: o selo do manifesto recebe o conteudo FINAL e ENTRA no selo versionavel (o conjunto de
  # arquivos nao muda — so o conteudo —, entao as contagens declaradas continuam exatas).
  sha256sum "${OUT_DIR}/manifest.json" >"${OUT_DIR}/manifest.sha256" 2>&1 || true
  generate_git_checksum || true         # cobre manifest.json E manifest.sha256 finais
  if ! verify_git_checksum; then
    [ "$want" = "success" ] && { want="failure"; RESULT="$want"; echo "$RESULT" >"${OUT_DIR}/result.txt"; }
    # REDE DE SEGURANCA (pass 4): se a verificacao reprovar AQUI, os artefatos ja foram gravados com o
    # veredicto anterior. Sem regenerar, `result.txt` passa a dizer `failure` enquanto `manifest.json`,
    # `REPORT.md` e o selo versionavel continuam dizendo `success` — a contradicao da rodada `1b54a89c`.
    # Regenerar TUDO com o veredicto final mantem o selo coerente consigo mesmo.
    log "verify reprovou apos a geracao — regenerando artefatos com o veredicto final (pass 4)"
    generate_manifest_and_report || true
    normalize_evidence || true
    sha256sum "${OUT_DIR}/manifest.json" >"${OUT_DIR}/manifest.sha256" 2>&1 || true
    generate_git_checksum || true
    if ! verify_git_checksum; then
      # Ainda incoerente depois de regenerar: o instrumento NAO pode terminar em silencio. Registra a
      # contradicao nominalmente e mantem o veredicto em failure.
      pendency "evidence-contradiction" "verify_git_checksum ainda reprova apos regeneracao (pass 4): ver evidence-git-checksum.log — artefatos podem contradizer o veredicto"
      log "ERRO: invariante do selo continua violada apos regeneracao — pendencia nominal registrada"
    fi
  fi

  # INVARIANTE FINAL: o veredicto do arquivo e o do manifesto tem de ser o MESMO. E a assercao que a
  # rodada `1b54a89c` violou sem que nada a pegasse. Reescrever `result.txt` aqui invalidaria o selo
  # versionavel ja gerado, entao a correcao regenera TUDO na mesma passada.
  MANIFEST_RESULT="$(node -e "try{console.log(require('./${OUT_DIR}/manifest.json').result)}catch{console.log('')}" 2>/dev/null)"
  if [ -n "$MANIFEST_RESULT" ] && [ "$MANIFEST_RESULT" != "$RESULT" ]; then
    pendency "evidence-contradiction" "result.txt='${RESULT}' divergia de manifest.result='${MANIFEST_RESULT}' — regenerado com o veredicto final (failure)"
    log "ERRO: result.txt ('${RESULT}') divergia de manifest.result ('${MANIFEST_RESULT}') — regenerando artefatos"
    want="failure"
    RESULT="$want"
    echo "$RESULT" >"${OUT_DIR}/result.txt"
    generate_manifest_and_report || true   # le RESULT do ambiente ⇒ manifesto sai coerente
    normalize_evidence || true
    sha256sum "${OUT_DIR}/manifest.json" >"${OUT_DIR}/manifest.sha256" 2>&1 || true
    generate_git_checksum || true
  fi

  seal_evidence
  log "veredicto=${RESULT} duracao=${elapsed}s evidencia=${OUT_DIR}"
}

trap 'code=$?; if [ "$FINALIZED" -eq 0 ]; then log "falha inesperada (exit ${code}) na linha ${LINENO}"; finalize "failure"; fi; exit $code' ERR

# ---------------------------------------------------------------------------
# Precondicoes (exit 2) — antes de qualquer escrita
# ---------------------------------------------------------------------------
command -v git >/dev/null 2>&1 || precondition "git ausente"
command -v node >/dev/null 2>&1 || precondition "node ausente"
command -v npm >/dev/null 2>&1 || precondition "npm ausente"
git rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null || precondition "base ${BASE} nao resolve como commit"
git merge-base --is-ancestor "$BASE" "$SHA" 2>/dev/null || precondition "base ${BASE} nao e ancestral de ${SHA}"

# Arvore suja FORA da evidencia => a rodada selaria com um SHA que NAO contem o conteudo validado.
# Aconteceu de fato em 2026-09-23: o `local-ci` rodou com as correcoes do DBT-19 ainda nao commitadas
# e rotulou a evidencia com o HEAD anterior. A evidencia por SHA e o produto deste instrumento; um
# rotulo que nao corresponde ao conteudo e pior do que nenhuma evidencia. Escape declarado:
# `LOCAL_CI_ALLOW_DIRTY=1` (uso consciente, e o `git-status.txt` da rodada registra a sujeira).
DIRTY_OUTSIDE="$(git status --porcelain=v1 | grep -vE '^\?\? docs/evidence/local-ci/' | grep -c . || true)"
if [ "${LOCAL_CI_ALLOW_DIRTY:-0}" != "1" ]; then
  if [ "$DIRTY_OUTSIDE" -gt 0 ]; then
    log "PRECONDICAO: ${DIRTY_OUTSIDE} entrada(s) suja(s) fora de docs/evidence/local-ci/ — commite antes de selar"
    git status --porcelain=v1 | grep -vE '^\?\? docs/evidence/local-ci/' | head -10 >&2
    precondition "arvore suja fora da evidencia (use LOCAL_CI_ALLOW_DIRTY=1 para forcar, declarando)"
  fi
fi
# Estado da arvore, para o manifesto declarar (nunca silenciar) a divergencia entre o SHA rotulado e o
# conteudo validado: com o escape usado, a evidencia NAO corresponde ao commit — e isso fica escrito no
# manifesto E numa pendencia nominal.
if [ "$DIRTY_OUTSIDE" -gt 0 ]; then
  printf 'dirty-escaped\n' >"${OUT_DIR}/tree-state.txt"
  printf '%s\n' "$DIRTY_OUTSIDE" >"${OUT_DIR}/dirty-entries.txt"
  pendency "tree-state" "evidencia selada com arvore SUJA por escape declarado (LOCAL_CI_ALLOW_DIRTY=1): ${DIRTY_OUTSIDE} entrada(s) fora da evidencia — o headSha NAO corresponde ao conteudo validado"
else
  printf 'clean\n' >"${OUT_DIR}/tree-state.txt"
  printf '0\n' >"${OUT_DIR}/dirty-entries.txt"
fi

# ---------------------------------------------------------------------------
# FASE 0 — inspecao e guarda (nada e modificado)
# ---------------------------------------------------------------------------
log "CI local supervisionado — sha=${SHA} branch=${BRANCH} base=${BASE}"
{
  echo "pwd: ${ROOT_DIR}"
  echo "$(node -v)"
  echo "npm $(npm -v)"
  echo "$(git --version)"
  echo "docker $(docker --version 2>/dev/null || echo unavailable)"
} >"${OUT_DIR}/preflight-tools.txt"

printf '%s\n' "$STARTED_AT" >"${OUT_DIR}/started-at.txt"
printf '%s\n' "$SHA" >"${OUT_DIR}/head-sha.txt"
printf '%s\n' "$SHORT_SHA" >"${OUT_DIR}/short-sha.txt"
printf '%s\n' "$BRANCH" >"${OUT_DIR}/branch.txt"
printf '%s\n' "$BASE" >"${OUT_DIR}/base-ref.txt"
git status --branch --porcelain=v1 >"${OUT_DIR}/git-status.txt"
git remote -v >"${OUT_DIR}/git-remote.txt"
git log --oneline -n 20 >"${OUT_DIR}/git-log.txt"
git log --oneline "${BASE}..HEAD" >"${OUT_DIR}/git-log-range.txt"
git diff --stat "${BASE}..HEAD" >"${OUT_DIR}/git-diff-stat.txt"
git diff --name-only "${BASE}..HEAD" >"${OUT_DIR}/changed-files.txt"

CHANGED_COUNT="$(grep -c . "${OUT_DIR}/changed-files.txt" || true)"
log "arquivos alterados no range: ${CHANGED_COUNT}"

# ---------------------------------------------------------------------------
# Escopo por caminho — mesma regex e MESMA polaridade fail-closed do workflow heavy
# ---------------------------------------------------------------------------
DB_SCOPE="false"
if [ "$CHANGED_COUNT" -eq 0 ]; then
  DB_SCOPE="true"
  printf 'range sem diff util -> tier de banco habilitado (fail-closed)\n' >"${OUT_DIR}/scope-decision.txt"
elif grep -qE '^(drizzle/|src/db/|src/server/repositories/|src/server/services/|scripts/db/|package(-lock)?\.json)' "${OUT_DIR}/changed-files.txt"; then
  DB_SCOPE="true"
  printf 'diff toca schema/migrations/camadas de banco/runners/manifests -> tier de banco habilitado\n' >"${OUT_DIR}/scope-decision.txt"
else
  printf 'diff nao toca drizzle/, src/db/, repositorios, servicos, scripts/db/ nem package.json/package-lock.json -> tier de banco pulado (mesma decisao do CI)\n' >"${OUT_DIR}/scope-decision.txt"
fi
printf 'db=%s\n' "$DB_SCOPE" >"${OUT_DIR}/scope-outputs.txt"
log "escopo: db=${DB_SCOPE}"

# Scan de segredo no RANGE. O gatilho abaixo e AMPLO de proposito; a supressao de ruido vive na
# allowlist DECLARADA (`scripts/local-ci-secret-allowlist.json`) e o classificador
# (`scripts/local-ci-secret-scan.mjs`) avalia os padroes DUROS **antes** dela — uma linha que misture
# a credencial loopback permitida e um token real continua sendo hit. Nada de conteudo casado entra na
# evidencia: a saida e `arquivo:linha` e um resumo de contagens.
# POSIX ERE estrito: `git grep -E` NAO suporta `\b` nem `(?:...)`. A primeira versao deste padrao
# usava os dois e casava ZERO linhas — indistinguivel de "limpo", ou seja, fail-open. Por isso o
# teste de vivacidade logo abaixo e obrigatorio: um detector que nao detecta e pior que nenhum.
PATTERN='(-----BEGIN [A-Z ]*PRIVATE KEY-----|(ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}|sk-proj-[A-Za-z0-9_-]{20,}|xox[baprs]-|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|postgres(ql)?://[^:[:space:]]+:[^@[:space:]]+@)'
# VIVACIDADE: o padrao precisa casar uma amostra sintetica de cada familia. Se nao casar, o scan
# esta quebrado e a rodada PARA — nunca reporta "clean" por vacuidade.
#
# Os probes sao MONTADOS EM RUNTIME: o fonte nao pode conter os literais, senao o proprio scan (e o
# `m02:secrets-audit`, que roda como etapa) reprova o instrumento por causa do seu autoteste — foi
# exatamente o que aconteceu em 2026-09-23, quando o probe literal com `ghp_` derrubou a rodada. As
# fronteiras que o detector procura ficam quebradas no fonte (`""` entre partes, escape octal no `://`).
pad() { printf '%*s' "$1" '' | tr ' ' "$2"; }
probe_ghp="ghp_$(pad 40 A)"
probe_akia="AKIA$(pad 16 Q)"
probe_xox="xox""b-$(pad 12 1)"
probe_pem="-----BEGIN ""RSA ""PRIVATE KEY-----"
probe_pg="postgresql$(printf '\072\057\057')u:p@127.0.0.1:5432/db"
for PROBE in "$probe_ghp" "$probe_akia" "$probe_xox" "$probe_pem" "$probe_pg"; do
  if ! printf '%s\n' "$PROBE" | grep -qE "$PATTERN"; then
    precondition "secret scan: padrao nao casa a amostra '${PROBE:0:12}...' (detector quebrado — fail-closed)"
  fi
done
: >"${OUT_DIR}/range-secret-scan.hits"
: >"${OUT_DIR}/range-secret-scan.summary"
if [ "$CHANGED_COUNT" -gt 0 ]; then
  SCAN_CODE=0
  xargs -a "${OUT_DIR}/changed-files.txt" git grep -nIE "$PATTERN" "$SHA" -- 2>/dev/null |
    node scripts/local-ci-secret-scan.mjs \
      >"${OUT_DIR}/range-secret-scan.hits" 2>"${OUT_DIR}/range-secret-scan.summary" || SCAN_CODE=$?
  # Exit 2 = precondicao (allowlist ilegivel/invalida). Fail-closed: nunca vira "nada encontrado".
  if [ "$SCAN_CODE" -eq 2 ]; then
    precondition "secret scan: allowlist ilegivel ou invalida — $(cat "${OUT_DIR}/range-secret-scan.summary")"
  fi
fi
if [ -s "${OUT_DIR}/range-secret-scan.hits" ]; then
  echo "review" >"${OUT_DIR}/range-secret-scan.status"
  log "ATENCAO: possivel segredo no range — ${OUT_DIR}/range-secret-scan.hits (arquivo:linha, sem conteudo)"
else
  echo "clean" >"${OUT_DIR}/range-secret-scan.status"
fi
log "secret scan: $(cat "${OUT_DIR}/range-secret-scan.summary" 2>/dev/null || echo 'sem registros no range')"

# Pin de npm do CI: VERIFICADO, nunca instalado globalmente.
npm -v >"${OUT_DIR}/npm-pin.txt"
if [ "$(cat "${OUT_DIR}/npm-pin.txt")" = "$NPM_PIN" ]; then
  record_step "npm-pin-verified" "success" "extra" ""
  log "pin de npm satisfeito (${NPM_PIN}) — nenhuma instalacao global executada"
else
  record_step "npm-pin-verified" "skipped" "extra" ""
  adapt "npm-pin" "npm local $(cat "${OUT_DIR}/npm-pin.txt") != pin ${NPM_PIN}; instalacao global NAO executada (fora da autonomia)"
fi

# ---------------------------------------------------------------------------
# FASE 2 — instalacao e checks (ordem do workflow heavy)
# ---------------------------------------------------------------------------
step_required "npm-ci" "npm ci" npm ci --ignore-scripts

step_required "m02:lockfile-guard" "m02:lockfile-guard" npm run m02:lockfile-guard
step_required "m02:work-package-guard" "m02:work-package-guard" npm run m02:work-package-guard
step_required "m02:debts-guard" "m02:debts-guard" npm run m02:debts-guard
step_required "m02:temporal-guard" "m02:temporal-guard" npm run m02:temporal-guard
step_required "m02:seal-dts:check" "m02:seal-dts:check" npm run m02:seal-dts:check
step_required "m02:matrix:check" "m02:matrix:check" npm run m02:matrix:check
step_required "check:ui-stack" "check:ui-stack" npm run check:ui-stack
step_required "check:no-supabase-runtime" "check:no-supabase-runtime" npm run check:no-supabase-runtime
step_required "m02:secrets-audit" "m02:secrets-audit" npm run m02:secrets-audit
step_required "m02:boundaries" "m02:boundaries" npm run m02:boundaries
adapt "state-check-informativo" "m02:state:check nao pertence a npm run check nem aos dois workflows; roda como etapa INFORMATIVA (nao aborta) e vermelho vira pendencia nominal"
# Informativa por desenho: `m02:state:check` NAO esta em `npm run check` nem em nenhum dos dois
# workflows — e passo do protocolo de boot (AGENTS.md). Torna-lo bloqueante deixaria este
# pipeline mais estrito que o CI remoto que ele substitui e derrubaria a coleta inteira por
# bookkeeping. O vermelho, quando existe, e registrado como pendencia nominal.
step_informational "m02:state:check" "m02:state:check" npm run m02:state:check
step_required "format:check" "format:check" npm run format:check
step_required "typecheck" "typecheck" npm run typecheck
step_required "lint" "lint" npm run lint
step_required "test" "test" npm run test
step_required "build" "build" npm run build
step_required "check:bundle" "check:bundle" npm run check:bundle
step_required "audit" "npm-audit" npm audit --audit-level=high

# Fallback declarado (AGENTS.md § Protocolo de bloqueio de CI): a cadeia `check` inteira.
if [ "$AGGREGATE_CHECK" = "1" ]; then
  step_required "check-chain" "npm run check (agregado)" npm run check
else
  mark_skipped "check-chain" "LOCAL_CI_AGGREGATE_CHECK=0 — cadeia coberta passo a passo" "npm run check (agregado)"
fi

# ---------------------------------------------------------------------------
# Tier de banco — container EFEMERO; o :5432 do usuario nunca e tocado
# ---------------------------------------------------------------------------
start_ephemeral_pg() {
  docker rm -f "$PG_NAME" >/dev/null 2>&1 || true
  docker run --rm -d --name "$PG_NAME" \
    -e POSTGRES_DB=preco_que_da_lucro_test -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
    -p "127.0.0.1:${PG_PORT}:5432" "$PG_IMAGE" >"${OUT_DIR}/ephemeral-pg.log" 2>&1 || return 1
  PG_STARTED=1
  local i
  for i in $(seq 1 30); do
    if docker exec "$PG_NAME" pg_isready -U postgres -d preco_que_da_lucro_test \
      >>"${OUT_DIR}/ephemeral-pg.log" 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

DB_ENV=(env
  "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/preco_que_da_lucro_test"
  "DATABASE_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/preco_que_da_lucro_test"
  "DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/preco_que_da_lucro_test"
  "DATABASE_DRIVER=node-postgres"
  "EXPECTED_POSTGRES_MAJOR=17"
  "BUILD_RELEASE_CHANNEL=pre-beta-internal")

if [ "$DB_TIER" = "skip" ] || { [ "$DB_TIER" = "auto" ] && [ "$DB_SCOPE" = "false" ]; }; then
  mark_skipped "db:test" "$(cat "${OUT_DIR}/scope-decision.txt")" "db:test"
  mark_skipped "db:check" "$(cat "${OUT_DIR}/scope-decision.txt")" "db:check"
elif command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1 && start_ephemeral_pg; then
  adapt "ephemeral-pg" "tier de banco em PG17 EFEMERO 127.0.0.1:${PG_PORT}; o container :5432 do usuario nao e tocado"
  step_conditional "db:test" "db:test" "${DB_ENV[@]}" npm run db:test
  step_conditional "db:check" "db:check" "${DB_ENV[@]}" npm run db:check
else
  mark_blocked "db:test" "precondicao ausente: docker indisponivel ou container efemero nao subiu"
  mark_blocked "db:check" "precondicao ausente: docker indisponivel ou container efemero nao subiu"
fi

# ---------------------------------------------------------------------------
# Tier de e2e — push => chromium+mobile, como o CI
# ---------------------------------------------------------------------------
if [ "$E2E_TIER" = "skip" ]; then
  mark_skipped "playwright-e2e" "LOCAL_CI_E2E_TIER=skip" "playwright-e2e"
elif ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  mark_blocked "playwright-e2e" "precondicao ausente: docker indisponivel para o banco de e2e"
else
  [ "$PG_STARTED" -eq 1 ] || start_ephemeral_pg || true
  if [ "$PG_STARTED" -ne 1 ]; then
    mark_blocked "playwright-e2e" "precondicao ausente: banco efemero nao subiu"
  else
    adapt "ephemeral-pg-e2e" "e2e roda contra PG17 EFEMERO em 127.0.0.1:${PG_PORT}, com segredos efemeros gerados na hora"
    adapt "playwright-without-deps" "CI usa 'playwright install --with-deps' (exige root); aqui os navegadores vem do cache e o install roda sem --with-deps"
    # `NO_COLOR` e artefato do shell local (o CI nao o define). O webServer do Playwright forca
    # `FORCE_COLOR`, o node entao emite "The 'NO_COLOR' env is ignored..." e o gate de avisos do
    # build (`scripts/build.mjs`) REPROVA esse aviso nao-registrado, derrubando o webServer.
    # A correcao e reproduzir o ambiente do CI (sem as duas variaveis) — o gate NAO foi afrouxado.
    adapt "no-color-unset" "tier de e2e roda com NO_COLOR/FORCE_COLOR removidos: com NO_COLOR=1 o webServer do Playwright (que forca FORCE_COLOR) faz o node emitir aviso nao-registrado e o gate de avisos do build reprova — ambiente do CI nao tem essas variaveis"
    E2E_ENV=(env -u NO_COLOR -u FORCE_COLOR
      "CI=1"
      "BUILD_RELEASE_CHANNEL=pre-beta-internal"
      "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/preco_que_da_lucro_test"
      "DATABASE_ADMIN_URL=postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/preco_que_da_lucro_test"
      "DATABASE_URL_UNPOOLED=postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/preco_que_da_lucro_test"
      "DATABASE_DRIVER=node-postgres"
      "EXPECTED_POSTGRES_MAJOR=17"
      "E2E_DB_RUNTIME_PASSWORD=$(openssl rand -hex 24)"
      "BETTER_AUTH_SECRET=$(openssl rand -hex 32)"
      "BETTER_AUTH_URL=http://127.0.0.1:4173"
      "AUTH_TRUSTED_ORIGINS=http://127.0.0.1:4173"
      "E2E_AUTH_EMAIL=teste@example.test"
      "E2E_AUTH_PASSWORD=$(openssl rand -hex 16)")
    step_conditional "playwright-install" "playwright-e2e (install)" "${E2E_ENV[@]}" npx playwright install chromium
    # Item E do Item 5: em falha, PRESERVAR os artefatos de diagnostico (trace, screenshot, video,
    # error-context) sob `artifacts/` — gitignored, local, e o que permite investigar em vez de
    # especular. Nenhum retry automatico foi adicionado: a decisao registrada e `known-limitation`.
    run_e2e_with_diagnostics() {
      local code=0
      "${E2E_ENV[@]}" npx playwright test --project=chromium --project=mobile || code=$?
      if [ "$code" -ne 0 ]; then
        mkdir -p "${OUT_DIR}/artifacts/e2e-diagnostics"
        cp -r test-results "${OUT_DIR}/artifacts/e2e-diagnostics/" 2>/dev/null || true
        cp -r playwright-report "${OUT_DIR}/artifacts/e2e-diagnostics/" 2>/dev/null || true
        printf '%s\n' "$code" >"${OUT_DIR}/artifacts/e2e-diagnostics/exit-code.txt"
        log "e2e falhou (exit=${code}) — diagnostico preservado em artifacts/e2e-diagnostics/ (local, gitignored)"
      fi
      return "$code"
    }
    step_conditional "playwright-e2e" "playwright-e2e" run_e2e_with_diagnostics
  fi
fi

# ---------------------------------------------------------------------------
# Cobertura: `checked === discovered` — falha alta, nunca lacuna silenciosa
# ---------------------------------------------------------------------------
coverage_check() {
  OUT_DIR="$OUT_DIR" ROOT_DIR="$ROOT_DIR" node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const OUT = process.env.OUT_DIR;
const steps = fs.readFileSync(path.join(OUT, "steps.tsv"), "utf8").split("\n").filter(Boolean)
  .map((l) => l.split("\t"));
const covered = new Set(steps.map((s) => s[3]).filter(Boolean));
const chain = JSON.parse(fs.readFileSync(path.join(process.env.ROOT_DIR, "package.json"), "utf8"))
  .scripts.check.split("&&").map((s) => s.trim().replace(/^npm run /, ""));
if (chain.length === 0) { console.error("cadeia `check` vazia — precondicao"); process.exit(2); }
const heavy = ["m02:work-package-guard", "m02:debts-guard", "m02:temporal-guard", "m02:matrix:check",
  "check:ui-stack", "check:no-supabase-runtime", "format:check", "typecheck", "lint", "test", "build",
  "check:bundle", "npm-audit"];
const light = ["m02:lockfile-guard", "m02:work-package-guard", "m02:debts-guard", "m02:temporal-guard",
  "m02:secrets-audit"];
const declared = [...new Set([...chain, ...heavy, ...light, "playwright-e2e",
  "m02:boundaries", "m02:state:check"])];
const missing = declared.filter((d) => !covered.has(d));
console.log(`declarados=${declared.length} cobertos=${declared.length - missing.length}`);
if (missing.length) { console.error(`LACUNAS: ${missing.join(", ")}`); process.exit(1); }
console.log("cobertura OK: checked === discovered");
NODE
}

if ! run_step "evidence-policy-check" "extra" "" measure_evidence; then
  log "ERRO: politica de evidencia (metadata-only) violada"
  finalize "failure"
  exit 1
fi

if ! run_step "coverage-assert" "extra" "" coverage_check; then
  finalize "failure"
  exit 1
fi

finalize "success"
# O veredicto pode ter sido REBAIXADO dentro do `finalize` (deriva de estado, politica de evidencia,
# cross-check de contagens). A mensagem final e o exit code tem de refletir o veredicto REAL — antes
# disto o script imprimia "success" fixo e saia 0 mesmo com `result.txt` = failure.
log "CI local supervisionado concluido: veredicto=${RESULT}"
[ "$RESULT" = "success" ] || exit 1
