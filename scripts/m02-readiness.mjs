import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
const ledgerPath = resolve(repositoryRoot, "EXECUTION-STATE-PROGRAM.md");
const g1MemoPath = resolve(repositoryRoot, "docs/specs/M-02/decisions/M02-D-008-G1-memo.md");
const backupDrillRoot = resolve(repositoryRoot, ".artifacts/backup-drill");
const tsxCli = resolve(repositoryRoot, "node_modules/tsx/dist/cli.mjs");

// Whitelist literal — mesma forma de scripts/build.mjs: process.execPath +
// array literal com caminhos internos fixos, sem shell e sem argv dinâmico.
const GATE_ARGS = {
  "substrate-smoke": () => [tsxCli, "scripts/smoke/substrate-smoke.ts"],
  "m02-matrix": () => [tsxCli, "scripts/m02-matrix.ts", "--check"],
  "m02-boundaries": () => [tsxCli, "scripts/m02-boundaries.ts"],
  "m02-state": () => [tsxCli, "scripts/m02-state-check.ts"],
};

const CHECK_TIMEOUT_MS = 180_000;

function snippet(stderr, stdout) {
  const raw = (stderr || stdout || "").trim().replace(/\s+/g, " ");
  return raw.slice(0, 240) || "sem saída";
}

// Códigos 0/1/2 na semântica do kit forense: 0 aprovado, 1 negativa
// determinística, 2 ambiente não produziu resultado confiável (fail-closed).
function runGateScript(gate) {
  return new Promise((done) => {
    if (!existsSync(tsxCli)) {
      done({ status: "DESCONHECIDO", detail: "tsx ausente em node_modules", stdout: "" });
      return;
    }
    const child = spawn(process.execPath, GATE_ARGS[gate](), {
      cwd: repositoryRoot,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), CHECK_TIMEOUT_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) done({ status: "PASS", detail: "exit 0", stdout });
      else if (code === 1) done({ status: "FAIL", detail: snippet(stderr, stdout), stdout });
      else if (code === null) done({ status: "DESCONHECIDO", detail: "timeout do gate", stdout });
      else
        done({
          status: "DESCONHECIDO",
          detail: `exit ${code}; ${snippet(stderr, stdout)}`,
          stdout,
        });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ status: "DESCONHECIDO", detail: `spawn falhou: ${err.message}`, stdout: "" });
    });
  });
}

function record(checks, id, status, source, detail) {
  checks.push({ id, status, source, detail });
}

function runSubstrate(checks) {
  const source = "scripts/smoke/substrate-smoke.ts (DATABASE_ADMIN_URL)";
  return runGateScript("substrate-smoke").then((res) => {
    if (res.status !== "PASS") {
      record(checks, "substrate-smoke", res.status, source, res.detail);
      return;
    }
    let detail = "exit 0";
    try {
      const parsed = JSON.parse(res.stdout);
      const failing = (parsed.results ?? []).filter((r) => r.status !== "PASS").map((r) => r.id);
      detail =
        parsed.result === "PASS" && failing.length === 0
          ? `exit 0; ${(parsed.results ?? []).length} checks PASS`
          : `result=${String(parsed.result)}; failing: ${failing.join(",") || "nenhum"}`;
    } catch {
      detail = "exit 0 (JSON de saída não parseável)";
    }
    record(checks, "substrate-smoke", "PASS", source, detail);
  });
}

function filledField(block, label) {
  const line = block.split("\n").find((l) => l.includes(label));
  if (!line) return false;
  const value = line.slice(line.indexOf(":") + 1).trim();
  return value.length > 0 && !/^_+$/.test(value);
}

function checkG1(checks) {
  const source = "docs/specs/M-02/decisions/M02-D-008-G1-memo.md";
  if (!existsSync(g1MemoPath)) {
    record(checks, "g1-assinada", "DESCONHECIDO", source, "memo G1 ausente");
    return;
  }
  const memo = readFileSync(g1MemoPath, "utf8");
  const idx = memo.indexOf("## G1 SIGNATURE");
  if (idx < 0) {
    record(checks, "g1-assinada", "DESCONHECIDO", source, "bloco G1 SIGNATURE ausente");
    return;
  }
  const next = memo.indexOf("\n## ", idx + 1);
  const block = memo.slice(idx, next < 0 ? undefined : next);
  const signed =
    filledField(block, "Nome") &&
    filledField(block, "Data") &&
    filledField(block, "Assinatura") &&
    /\[\s*[xX]\s*\]/.test(block);
  record(
    checks,
    "g1-assinada",
    signed ? "PASS" : "FAIL",
    source,
    signed
      ? "bloco G1 SIGNATURE preenchido"
      : "bloco G1 SIGNATURE vazio (M02-D-008; sunset 2026-09-20)",
  );
}

function checkLedgerRule(checks, id, ledger, okDetail, failDetail, matches) {
  const declared = ledger.split("\n").some(matches);
  record(
    checks,
    id,
    declared ? "PASS" : "FAIL",
    "EXECUTION-STATE-PROGRAM.md",
    declared ? okDetail : failDetail,
  );
}

// N-5/N-6 (Emenda #6, DP5=(b)): o gate consome o trio exato
// dump.pgc + dump.pgc.sha256 + metadata.json sob o glob literal
// .artifacts/backup-drill/*/dump.pgc. Frescor = created_at da metadata
// (0 <= idade < 24h); mtime NUNCA define frescor (nem seleção, nem idade);
// trio inválido, futuro, divergente ou incompleto NUNCA produz PASS.
const TRIO_DUMP_FILENAME = "dump.pgc";
const TRIO_SHA_FILENAME = "dump.pgc.sha256";
const TRIO_META_FILENAME = "metadata.json";
const FRESHNESS_WINDOW_MS = 24 * 3_600_000;

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function evaluateSnapshotDir(dirPath, nowMs) {
  const reasons = [];
  let dumpBytes = null;
  try {
    dumpBytes = readFileSync(resolve(dirPath, TRIO_DUMP_FILENAME));
  } catch {
    return { ok: false, createdAtMs: null, reasons: ["dump.pgc ausente/ilegível"] };
  }
  let sidecar = null;
  try {
    sidecar = readFileSync(resolve(dirPath, TRIO_SHA_FILENAME), "utf8");
  } catch {
    reasons.push("dump.pgc.sha256 ausente/ilegível");
  }
  let meta = null;
  try {
    const parsed = JSON.parse(readFileSync(resolve(dirPath, TRIO_META_FILENAME), "utf8"));
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed;
    } else {
      reasons.push("metadata.json inválida (não-objeto)");
    }
  } catch {
    reasons.push("metadata.json ausente/inválida");
  }
  if (meta !== null) {
    if (meta.producer !== "m02:snapshot") reasons.push("producer inesperado");
    if (meta.source !== "production") reasons.push("source inesperada");
    if (meta.connection_kind !== "direct") reasons.push("connection_kind diferente de direct");
    if (meta.read_only !== true) reasons.push("read_only falso");
    if (typeof meta.motivo !== "string" || meta.motivo.trim() === "") reasons.push("motivo vazio");
    if (typeof meta.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(meta.sha256))
      reasons.push("sha256 declarado ausente/inválido");
  }
  const actual = sha256Hex(dumpBytes);
  if (
    meta !== null &&
    typeof meta.sha256 === "string" &&
    /^[0-9a-f]{64}$/i.test(meta.sha256) &&
    meta.sha256.toLowerCase() !== actual
  ) {
    reasons.push("hash divergente (conteúdo ≠ declarado)");
  }
  if (sidecar !== null) {
    const token = sidecar.trim().split(/\s+/)[0];
    if (!/^[0-9a-f]{64}$/i.test(token)) reasons.push("sidecar sem hash válido");
    else if (token.toLowerCase() !== actual) reasons.push("hash divergente (conteúdo ≠ sidecar)");
  }
  let createdAtMs = null;
  if (meta !== null) {
    const parsed = typeof meta.created_at === "string" ? Date.parse(meta.created_at) : NaN;
    if (Number.isNaN(parsed)) reasons.push("created_at inválida");
    else createdAtMs = parsed;
  }
  if (createdAtMs !== null && createdAtMs > nowMs) reasons.push("created_at futura");
  return { ok: reasons.length === 0, createdAtMs, reasons };
}

function checkSnapshotFromRoot(rootDir, nowMs) {
  const source = ".artifacts/backup-drill/*/dump.pgc";
  let sawDump = false;
  let best = null;
  const invalidNotes = [];
  if (existsSync(rootDir)) {
    for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = resolve(rootDir, entry.name);
      if (!existsSync(resolve(dir, TRIO_DUMP_FILENAME))) continue;
      sawDump = true;
      const verdict = evaluateSnapshotDir(dir, nowMs);
      if (verdict.ok && verdict.createdAtMs !== null) {
        if (best === null || verdict.createdAtMs > best.createdAtMs) {
          best = { createdAtMs: verdict.createdAtMs, dir: entry.name };
        }
      } else {
        invalidNotes.push(`${entry.name}: ${verdict.reasons.join("; ")}`);
      }
    }
  }
  if (!sawDump) {
    return {
      status: "DESCONHECIDO",
      source,
      detail:
        "nenhum dump externo encontrado; snapshot nativo (snap-tiny-smoke-ayc382ji) vale até 2026-10-10, mas <24h não comprovado",
    };
  }
  if (best === null) {
    return {
      status: "FAIL",
      source,
      detail: `trios presentes mas nenhum válido: ${invalidNotes.join(" | ").slice(0, 200)}`,
    };
  }
  const ageH = (nowMs - best.createdAtMs) / 3_600_000;
  if (ageH < 24) {
    return {
      status: "PASS",
      source,
      detail: `trio válido em ${best.dir}; idade ${ageH.toFixed(1)}h por created_at (mtime ignorado)`,
    };
  }
  return {
    status: "FAIL",
    source,
    detail: `trio válido mais novo com ${ageH.toFixed(1)}h por created_at (exige snapshot novo no dia do cutover)`,
  };
}

function checkSnapshot(checks, nowMs = Date.now()) {
  const verdict = checkSnapshotFromRoot(backupDrillRoot, nowMs);
  record(checks, "snapshot-fresco", verdict.status, verdict.source, verdict.detail);
}

export { evaluateSnapshotDir, checkSnapshotFromRoot };

async function main() {
  const checks = [];
  const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";

  // 1. Integridade do substrato (read-only): smoke completo.
  await runSubstrate(checks);

  // 2. Gates M-02 locais.
  for (const gate of ["m02-matrix", "m02-boundaries", "m02-state"]) {
    const res = await runGateScript(gate);
    record(checks, gate, res.status, GATE_ARGS[gate]()[1], res.detail);
  }

  // 3. Agenda humana e operação (fontes documentais, fail-closed).
  checkG1(checks);
  if (ledger) {
    checkLedgerRule(
      checks,
      "sec01-fechada",
      ledger,
      "registro de fechamento/revogação encontrado no ledger",
      "sem registro de fechamento (revogação no emissor das 5 credenciais de neon-storage.env é ação humana)",
      (line) => /SEC-01/.test(line) && /fechada|encerrada|revogad|closed/i.test(line),
    );
    checkLedgerRule(
      checks,
      "freeze-ativo",
      ledger,
      "declaração de freeze ativo encontrada no ledger",
      "sem declaração; convencionar linha no ledger contendo 'freeze ativo' + janela (M02-D-009)",
      (line) => /\bfreeze\b/i.test(line) && /\bativo\b/i.test(line),
    );
  } else {
    record(checks, "sec01-fechada", "DESCONHECIDO", "EXECUTION-STATE-PROGRAM.md", "ledger ausente");
    record(checks, "freeze-ativo", "DESCONHECIDO", "EXECUTION-STATE-PROGRAM.md", "ledger ausente");
  }
  checkSnapshot(checks);

  const anyUnknown = checks.some((c) => c.status === "DESCONHECIDO");
  const anyFail = checks.some((c) => c.status === "FAIL");
  const result = anyUnknown ? "INCOMPLETE" : anyFail ? "FAIL" : "PASS";

  console.log(
    JSON.stringify(
      {
        check: "m02:readiness",
        fail_closed: true,
        started_at: new Date().toISOString(),
        result,
        checks,
        notes:
          "PASS só com todos os checks PASS. INCOMPLETE (exit 2) = ambiente não produziu resultado confiável. GO/NO-GO do cutover é decisão documentada, não saída deste script.",
      },
      null,
      2,
    ),
  );
  process.exitCode = result === "PASS" ? 0 : result === "FAIL" ? 1 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
