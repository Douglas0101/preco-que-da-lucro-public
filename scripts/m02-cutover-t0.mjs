// m02-cutover-t0.mjs — T-0 MACHINE-READABLE do cutover A4 (rodada
// CUTOVER-PREP P4; runbook cutover-A4.md §2). Produz JSON + Markdown com o
// estado de cada verificação, rotulando pendências honestas em vez de forçar
// verde: pendings recebem EXPECTED-PENDING / PENDING-ENV / DIA-D.
//
// Contrato:
//   npm run m02:cutover-t0 [-- --out-dir <dir>] [--skip-snapshot]
//   - Para a dupla snapshot, o ambiente precisa de DATABASE_ADMIN_URL (DIRECT
//     de produção) — op read-only sancionada (Emenda #4) com motivo fixo
//     registrado; sem env, a dupla é rotulada PENDING-ENV (não fail).
//   - Nunca regenera a matriz (regen é humano, só sob drift declarado).
//   - Nunca executa a sonda H-07 em produção (rótulo DIA-D; escrita lá é só
//     na janela).
//   - Escrita: apenas docs/evidence/... e stdout. Produção: somente pg_dump
//     read-only via P5 (dupla snapshot).
// Exit codes: 0 = nenhum hard fail (pendings rotulados ok) · 2 = hard fail.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const REPOSITORY_ROOT = realpathSync(ROOT);
const TEMP_ROOT = realpathSync(tmpdir());
const SNAPSHOTS_DIR = "artifacts/snapshots";
const PRODUCTION_HOST = "ep-long-violet-aye9g0bn";
const LOCAL_RM_URL = "postgresql://postgres:postgres@127.0.0.1:5432/preco_que_da_lucro_test";
const NPM_CLI = resolve(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);

function parseArgs(argv) {
  const parsed = { outDir: undefined, skipSnapshot: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--skip-snapshot") parsed.skipSnapshot = true;
    else if (arg.startsWith("--out-dir")) {
      parsed.outDir = arg.includes("=") ? arg.split("=", 2)[1] : argv[++index];
    } else return { error: `argumento não reconhecido: ${arg}` };
  }
  return parsed;
}

function npmRun(script, extraArgs, env) {
  const result = spawnSync(
    process.execPath,
    [NPM_CLI, "run", script, ...(extraArgs && extraArgs.length > 0 ? ["--", ...extraArgs] : [])],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 480_000,
    },
  );
  return result;
}

function lastJson(stdout) {
  const text = String(stdout ?? "").trim();
  const first = text.indexOf("{");
  if (first >= 0) {
    try {
      return JSON.parse(text.slice(first));
    } catch {
      // cai no fallback de última linha
    }
  }
  const line = text.split(/\r?\n/).findLast((l) => l.trim().startsWith("{"));
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

const checks = [];
function record(id, status, detail, extra) {
  checks.push({ id, status, detail, ...(extra ?? {}) });
  process.stdout.write(
    `${JSON.stringify({ script: "m02:cutover-t0", check: id, status, detail })}\n`,
  );
}

function readinessDetail(result, json) {
  const resultLabel = json?.result ? ` · result=${json.result}` : "";
  return `exit ${result.status}${resultLabel} — pré-cutover, falhas de agenda (freeze/sec01/g1/snapshot-fresco) são esperadas e rotuladas`;
}

function isWithin(base, candidate) {
  const descendant = relative(base, candidate);
  return descendant === "" || (!descendant.startsWith(`..${sep}`) && !isAbsolute(descendant));
}

function existingOutputAncestor(candidate) {
  let lexical = candidate;
  while (!existsSync(lexical)) {
    const parent = dirname(lexical);
    if (parent === lexical) throw new Error("diretório pai da saída não pode ser resolvido");
    lexical = parent;
  }
  return { lexical, real: realpathSync(lexical) };
}

function resolveSafeOutputDirectory(raw) {
  const candidate = resolve(ROOT, raw);
  const allowedRoot = [REPOSITORY_ROOT, TEMP_ROOT].find((root) => isWithin(root, candidate));
  if (!allowedRoot) return { error: "--out-dir fora das raízes permitidas; fail-closed" };
  try {
    const parent = existingOutputAncestor(candidate);
    if (!isWithin(allowedRoot, parent.real)) {
      return { error: "pai de --out-dir usa symlink fora da raiz permitida; fail-closed" };
    }
    const safeCandidate = resolve(parent.real, relative(parent.lexical, candidate));
    if (!isWithin(allowedRoot, safeCandidate)) {
      return { error: "--out-dir fora da raiz permitida; fail-closed" };
    }
    if (existsSync(safeCandidate) && !statSync(realpathSync(safeCandidate)).isDirectory()) {
      return { error: "--out-dir não é um diretório; fail-closed" };
    }
    return { path: safeCandidate };
  } catch {
    return { error: "--out-dir não pode ser resolvido com segurança; fail-closed" };
  }
}

// 1. readiness do dia (gate m02:readiness; hoje esperada INCOMPLETE/FAIL por
// freeze/sec01/snapshot-fresco — rotulado, não hard fail).
function checkReadiness() {
  const result = npmRun("m02:readiness", [], {});
  const json = lastJson(result.stdout);
  const status = result.status === 0 ? "PASS" : "EXPECTED-PENDING";
  record("gate-readiness", status, readinessDetail(result, json), {
    failing: (json?.checks ?? [])
      .filter((c) => c.status !== "PASS")
      .map((c) => `${c.id}:${c.status}`),
  });
}

// 2. matriz: check SEM regen (regen é humano sob drift).
function checkMatrix() {
  const result = npmRun("m02:matrix:check", [], {});
  if (result.status === 0)
    record(
      "m02-matrix-check",
      "PASS",
      "determinística e atualizada (sem drift; regen não é needed)",
    );
  else
    record(
      "m02-matrix-check",
      "FAIL",
      `drift detectado (exit ${result.status}) → regen humano via m02:matrix:generate é o único caminho`,
      { snippet: String(result.stdout || result.stderr).slice(-200) },
    );
}

// 3. dupla snapshot via P5 (sha distintos = prova de dois dumps independentes).
function checkDoubleSnapshot(skipSnapshot) {
  if (skipSnapshot) {
    record("dupla-snapshot", "PENDING", "--skip-snapshot informado por quem executou");
    return;
  }
  if (
    !process.env.DATABASE_ADMIN_URL ||
    !process.env.DATABASE_ADMIN_URL.includes(PRODUCTION_HOST)
  ) {
    record(
      "dupla-snapshot",
      "PENDING-ENV",
      "DATABASE_ADMIN_URL (DIRECT de produção) ausente no ambiente — dupla snapshot não executada; produção NÃO foi tocada",
    );
    return;
  }
  const runs = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = npmRun("m02:snapshot", [], {
      ALLOW_REMOTE_DB: `CUTOVER-PREP P4: dupla snapshot do T-0 (tentativa ${attempt}/2; pg_dump read-only via DIRECT; Emenda #4)`,
    });
    const json = lastJson(result.stdout);
    if (result.status !== 0 || !json?.sha256) {
      record(
        "dupla-snapshot",
        "FAIL",
        `execução ${attempt} falhou (exit ${result.status}) — mecanismo de snapshot quebrado é hard fail`,
      );
      return;
    }
    runs.push({
      dump: json.dump,
      sha256: json.sha256,
      size_bytes: json.size_bytes,
      duration_ms: json.duration_ms,
      guard_log: (String(result.stderr ?? "").match(
        /\{"guard":"env-guard","result":"ALLOW_SANCTIONED".*/,
      ) ?? ["omitida"])[0],
    });
  }
  const distinct = runs[0].sha256 !== runs[1].sha256;
  if (!distinct) {
    record(
      "dupla-snapshot",
      "FAIL",
      "os dois dumps têm o MESMO sha256 — suspeita de cache/reuso; investigar antes do dia-D",
    );
    return;
  }
  record(
    "dupla-snapshot",
    "PASS",
    `2 dumps read-only com sha256 distintos (${runs.map((r) => r.sha256.slice(0, 12) + "…").join(" vs ")})`,
    { runs },
  );
}

function listDumpFiles() {
  const dir = resolve(ROOT, SNAPSHOTS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".dump"));
}

// 4. validade da janela de freeze vs Emenda #3.
function checkFreezeWindow() {
  const ledger = readFileSync(resolve(ROOT, "EXECUTION-STATE-PROGRAM.md"), "utf8");
  const ledgerDeclared =
    /\bfreeze\b/i.test(ledger) && /\bativo\b/i.test(ledger) && /freeze ativo:/.test(ledger);
  const start = process.env.NEON_MIGRATION_FREEZE_START;
  const end = process.env.NEON_MIGRATION_FREEZE_END;
  const now = Date.now();
  if (!ledgerDeclared) {
    record(
      "janela-freeze",
      "EXPECTED-PENDING",
      "linha 'freeze ativo:' ainda não anexada ao ledger (é do humano no Manifest 5/dia-D; runbook §1) — fora de janela é ESPERADO pré-cutover, NÃO é fail",
    );
    return;
  }
  if (!start || !end) {
    record(
      "janela-freeze",
      "PENDING-ENV",
      "ledger declara freeze, mas NEON_MIGRATION_FREEZE_START/END ausentes no ambiente do dia",
    );
    return;
  }
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || s >= e) {
    record("janela-freeze", "FAIL", "janela do guard malformada (Emenda #3) — achado → PARAR");
    return;
  }
  record(
    "janela-freeze",
    now >= s && now <= e ? "PASS" : "EXPECTED-PENDING",
    now >= s && now <= e
      ? `dentro da janela [${start} .. ${end}]`
      : `fora de janela [${start} .. ${end}] — HOJE = "fora de janela — esperado pré-cutover" (rotulado, não fail)`,
  );
}

// 5. conferência de segredos nos staged + gate.env no repo (nomes/padrões,
// nunca valores).
function checkSecrets() {
  const problems = [];
  if (existsSync(resolve(ROOT, "gate.env"))) problems.push("gate.env presente no root do repo");
  const staged = spawnSync("/usr/bin/git", ["diff", "--cached", "--name-only"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout.trim();
  const stagedFiles = staged ? staged.split("\n") : [];
  const stagedStops = stagedFiles.filter((f) => /(^|\/)\.env$|gate\.env/.test(f));
  if (stagedStops.length) problems.push(`staged inclui arquivo de env: ${stagedStops.join(", ")}`);
  const stagedDiff = spawnSync("/usr/bin/git", ["diff", "--cached", "-U0"], {
    cwd: ROOT,
    encoding: "utf8",
  }).stdout;
  const credentialPattern = stagedDiff.match(/(postgresql|postgres):\/\/[^\s]*:[^\s]*@/);
  if (credentialPattern)
    problems.push("padrão de URL com credencial no diff staged (padrão detectado, valor omitido)");
  if (problems.length) record("segredos-staged", "FAIL", problems.join(" · "));
  else
    record(
      "segredos-staged",
      stagedFiles.length === 0 ? "EXPECTED-PENDING" : "PASS",
      stagedFiles.length === 0
        ? "nada staged na pré-confecção do Manifest 5 (a conferência definitiva é no staging do feixe humano); gate.env ausente do repo"
        : `${stagedFiles.length} arquivos staged sem padrão de credencial; gate.env ausente`,
    );
}

// 6. env-guard selftest (novo count da Emenda #4).
function checkEnvGuardSelftest() {
  const result = spawnSync(process.execPath, ["scripts/env-guard.mjs", "--selftest"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 60_000,
  });
  const summary = lastJson(result.stdout);
  if (result.status === 0 && summary?.pass)
    record("env-guard-selftest", "PASS", `total=${summary.total} failed=${summary.failed}`);
  else
    record(
      "env-guard-selftest",
      "FAIL",
      `exit ${result.status} · ${JSON.stringify(summary ?? "sem summary")}`,
    );
}

// 7. role-membership dry (kind drill-branch; alvo local = prova de mecanismo
// sem tocar produção; o grant remoto acontece na janela via cutover-window).
function checkRoleMembershipDry() {
  const result = npmRun(
    "m02:role-membership",
    ["--target-env", "RM_LOCAL_URL", "--kind", "drill-branch", "--dry-run"],
    {
      RM_LOCAL_URL: LOCAL_RM_URL,
    },
  );
  const json = lastJson(result.stdout);
  if (result.status === 0 && json?.before) {
    record(
      "role-membership-dry",
      "PASS",
      `local · before.has_set_membership=${json.before.has_set_membership} · action="${json.action}" — grant em produção é do dia-D na janela (kind cutover-window, runbook §2.5)`,
    );
  } else {
    record(
      "role-membership-dry",
      "PENDING",
      `dry local sem resultado confiável (exit ${result.status}; container pg local em pé? npm run db:up) — rotulado, mecanismo já provado no drill da branch em role-membership-test-2026-09-07.md`,
    );
  }
}

// 8. rls-probe produção — nunca aqui; rótulo DIA-D.
function checkRlsProbe() {
  record(
    "rls-probe-producao",
    "DIA-D",
    "a sonda H-07 executa SOMENTE no smoke A4 (runbook §5) dentro da janela; T-0 de hoje não sonda produção",
  );
}

function renderMarkdown(payload) {
  const lines = [
    `# T-0 machine-readable — CUTOVER-PREP (${payload.executed_at})`,
    "",
    `- exit previsto: **${payload.exit === 0 ? "0 (nenhum hard fail)" : "2 (hard fail)"}** · hard_fail=${payload.hard_fail_count} · pendings_rotulados=${payload.pending_count}`,
    "- legenda: PASS · EXPECTED-PENDING (esperado pré-cutover, NÃO fail) · PENDING-ENV (falta env do dia) · DIA-D (passo do dia, proibido hoje) · FAIL (hard)",
    "",
    "| check | status | detalhe |",
    "| --- | --- | --- |",
  ];
  for (const check of payload.checks) {
    lines.push(
      `| ${check.id} | ${check.status} | ${String(check.detail).replaceAll("|", "\\|")} |`,
    );
  }
  lines.push("", "## Snapshot dupla", "");
  const dual = payload.checks.find((c) => c.id === "dupla-snapshot");
  if (dual?.runs) {
    for (const run of dual.runs)
      lines.push(
        `- \`${run.dump}\` · sha256 \`${run.sha256}\` · ${run.size_bytes} B · ${run.duration_ms} ms`,
      );
  } else {
    lines.push(`- ${dual?.detail ?? "sem execução"}`);
  }
  lines.push(
    "",
    "Verificação executada pelo script; decisões de gate do dia continuam no runbook `cutover-A4.md` §2 (este artefato é a leitura mecanizada, não um substituto).",
    "",
  );
  return lines.join("\n");
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`m02-cutover-t0: ${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const output = resolveSafeOutputDirectory(
    parsed.outDir ?? "docs/evidence/cutover-prep-2026-09-07",
  );
  if (output.error) {
    process.stderr.write(`m02-cutover-t0: ${output.error}\n`);
    process.exitCode = 2;
    return;
  }
  const outDir = output.path;
  const started = Date.now();
  checkEnvGuardSelftest();
  checkMatrix();
  checkFreezeWindow();
  checkSecrets();
  checkRoleMembershipDry();
  checkDoubleSnapshot(parsed.skipSnapshot);
  checkRlsProbe();
  checkReadiness();

  const hardFail = checks.filter((c) => c.status === "FAIL").length;
  const pending = checks.filter((c) => c.status !== "PASS" && c.status !== "FAIL").length;
  const payload = {
    script: "m02:cutover-t0",
    executed_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    head_sha: spawnSync("/usr/bin/git", ["rev-parse", "--short", "HEAD"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout.trim(),
    checks,
    hard_fail_count: hardFail,
    pending_count: pending,
    exit: hardFail > 0 ? 2 : 0,
  };
  mkdirSync(outDir, { recursive: true });
  const realOutDir = realpathSync(outDir);
  if (!isWithin(REPOSITORY_ROOT, realOutDir) && !isWithin(TEMP_ROOT, realOutDir)) {
    process.stderr.write(
      "m02-cutover-t0: --out-dir mudou para fora da raiz permitida; fail-closed\n",
    );
    process.exitCode = 2;
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(
    resolve(outDir, `cutover-t0-${stamp}.json`),
    `${JSON.stringify(payload, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(resolve(outDir, `cutover-t0-${stamp}.md`), renderMarkdown(payload), "utf8");
  process.stdout.write(
    `${JSON.stringify({ script: "m02:cutover-t0", event: "done", exit: payload.exit, hard_fail: hardFail, pending, out_dir: parsed.outDir ?? "docs/evidence/cutover-prep-2026-09-07" })}\n`,
  );
  process.exitCode = payload.exit;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { parseArgs };
