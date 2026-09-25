#!/usr/bin/env node
/**
 * m02-lockfile-guard.mjs — guarda fail-closed para o incidente de lockfile (F-REPO).
 *
 * Checks (read-only):
 *   1. package.json devDependencies["drizzle-kit"] casa ^0.31.x
 *   2. package-lock.json espelha a spec e resolve 0.31.x
 *   3. sha256(package-lock.json) == sha256(HEAD:package-lock.json)
 *   4. node_modules/drizzle-kit (se presente) == 0.31.x
 *
 * Saída: JSON (stdout). Exit: 0 = pass · 1 = fail (fail-closed).
 * Uso: node scripts/m02-lockfile-guard.mjs [--no-node-modules]
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const SPEC_RE = /^\^0\.31\.\d+$/;
const RESOLVED_RE = /^0\.31\.\d+$/;
const PKG = "package.json";
const LOCK = "package-lock.json";

const argv = process.argv.slice(2);
const checkNodeModules = !argv.includes("--no-node-modules");
const checks = [];
const reasons = [];
const observed = {};

const check = (id, status, detail) => {
  checks.push({ id, status, detail });
  if (status === "fail") reasons.push(`${id}: ${detail}`);
};
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function emit(ok, error) {
  process.stdout.write(
    JSON.stringify(
      {
        schema: "m02-lockfile-guard/1",
        ok,
        status: ok ? "pass" : "fail",
        generatedAt: new Date().toISOString(),
        repo: process.cwd(),
        observed,
        checks,
        reasons,
        hint: "git checkout -- package.json package-lock.json && npm ci --ignore-scripts && npm run m02:lockfile-guard",
        ...(error ? { error } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(ok ? 0 : 1);
}

try {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) process.chdir(top);
  } catch {
    /* cwd mantido; fail-closed adiante */
  }

  const pkgRaw = readFileSync(PKG, "utf8");
  const lockRaw = readFileSync(LOCK, "utf8");

  const pkg = JSON.parse(pkgRaw);
  const spec = pkg?.devDependencies?.["drizzle-kit"] ?? null;
  observed.spec = spec;
  if (!spec) check("package-json-devdep", "fail", "devDependencies['drizzle-kit'] ausente");
  else if (!SPEC_RE.test(spec))
    check("package-json-devdep", "fail", `spec '${spec}' fora do contrato ^0.31.x`);
  else check("package-json-devdep", "pass", `spec '${spec}'`);

  const lock = JSON.parse(lockRaw);
  const lockSpec = lock?.packages?.[""]?.devDependencies?.["drizzle-kit"] ?? null;
  observed.lockSpec = lockSpec;
  if (lockSpec !== spec)
    check("lock-top-spec", "fail", `lock '${lockSpec}' != package.json '${spec}'`);
  else check("lock-top-spec", "pass", `lock '${lockSpec}'`);

  const resolved = lock?.packages?.["node_modules/drizzle-kit"] ?? null;
  observed.lockResolvedVersion = resolved?.version ?? null;
  if (!resolved) check("lock-resolved", "fail", "entrada node_modules/drizzle-kit ausente no lock");
  else if (!RESOLVED_RE.test(resolved.version ?? ""))
    check("lock-resolved", "fail", `resolvido '${resolved.version}' fora de 0.31.x`);
  else check("lock-resolved", "pass", `resolvido ${resolved.version}`);

  const lockSha = sha256(lockRaw);
  observed.lockSha256 = lockSha;
  let headLock = null;
  try {
    headLock = execFileSync("git", ["show", `HEAD:${LOCK}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    check("lock-sha256-head", "fail", "não foi possível ler HEAD:package-lock.json");
  }
  if (headLock !== null) {
    const headSha = sha256(Buffer.from(headLock, "utf8"));
    observed.headLockSha256 = headSha;
    if (headSha !== lockSha)
      check(
        "lock-sha256-head",
        "fail",
        `lock do worktree ${lockSha} != HEAD ${headSha} (reescrito sem commit)`,
      );
    else check("lock-sha256-head", "pass", lockSha);
  }

  if (checkNodeModules) {
    const nm = path.join("node_modules", "drizzle-kit", "package.json");
    if (!existsSync(nm)) {
      check(
        "node-modules-installed",
        "skipped",
        "node_modules/drizzle-kit ausente (npm ci pendente)",
      );
    } else {
      const installed = JSON.parse(readFileSync(nm, "utf8"))?.version ?? null;
      observed.installedVersion = installed;
      if (!RESOLVED_RE.test(installed ?? ""))
        check("node-modules-installed", "fail", `instalado ${installed} fora de 0.31.x`);
      else check("node-modules-installed", "pass", `instalado ${installed}`);
    }
  }

  emit(reasons.length === 0);
} catch (err) {
  check("guard-runtime", "fail", `erro interno: ${err?.message ?? String(err)}`);
  emit(false, String(err?.message ?? err));
}
