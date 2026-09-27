#!/usr/bin/env node
/**
 * m02-lockfile-guard.mjs — guarda fail-closed para o incidente de lockfile (F-REPO).
 *
 * A faixa de versão NÃO é declarada aqui: ela vem de `scripts/dependency-policy.json`,
 * a fonte única compartilhada com o `upgrade-guard` e o `migration-toolchain-guard`.
 * Duas listas de versão em dois lugares divergem sozinhas — foi exatamente o que a
 * política veio eliminar.
 *
 * Checks (read-only):
 *   1. a política declara `drizzle-kit` com faixa utilizável
 *   2. package.json devDependencies["drizzle-kit"] cai na faixa
 *   3. package-lock.json espelha a spec e resolve dentro da faixa
 *   4. sha256(package-lock.json) == sha256(HEAD:package-lock.json)
 *   5. node_modules/drizzle-kit (se presente) dentro da faixa
 *
 * Saída: JSON (stdout). Exit: 0 = pass · 1 = fail (veredito) · 2 = precondição.
 * Uso: node scripts/m02-lockfile-guard.mjs [--no-node-modules]
 */
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const GUARDED = "drizzle-kit";
const POLICY = "scripts/dependency-policy.json";
const PKG = "package.json";
const LOCK = "package-lock.json";

/** Compara major.minor.patch numericamente; pre-release ignorado. Sem `semver`. */
function compareVersions(a, b) {
  const parse = (v) =>
    String(v)
      .split("-")[0]
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const left = parse(a);
  const right = parse(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] > right[i]) return 1;
    if (left[i] < right[i]) return -1;
  }
  return 0;
}

/** Menor versão declarada por uma spec (`^1.2.3`, `~1.2.3`, `1.2.3` → `1.2.3`). */
function baseVersion(spec) {
  const found = /(\d+)\.(\d+)\.(\d+)/.exec(String(spec));
  return found ? `${found[1]}.${found[2]}.${found[3]}` : null;
}

function inRange(version, min, max) {
  return compareVersions(version, min) >= 0 && compareVersions(version, max) <= 0;
}

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

function emit(ok, error, code) {
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
  process.exit(code ?? (ok ? 0 : 1));
}

try {
  try {
    const top = execFileSync("/usr/bin/git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) process.chdir(top);
  } catch {
    /* cwd mantido; fail-closed adiante */
  }

  const pkgRaw = readFileSync(PKG, "utf8");
  const lockRaw = readFileSync(LOCK, "utf8");

  // A faixa vem da política compartilhada; política ausente ou sem o pacote
  // protegido é PRECONDIÇÃO, não veredito — e nunca passa em silêncio.
  let range = null;
  if (!existsSync(POLICY)) {
    check("dependency-policy", "fail", `${POLICY} ausente: a faixa aprovada é precondição`);
    emit(false, `${POLICY} ausente`, 2);
  }
  const policy = JSON.parse(readFileSync(POLICY, "utf8"));
  const entry = policy?.packages?.find((p) => p?.name === GUARDED) ?? null;
  const min = entry?.min ?? null;
  const max = entry?.max ?? null;
  observed.policyRange = { package: GUARDED, min, max, criticality: entry?.criticality ?? null };
  if (!entry) {
    check("dependency-policy", "fail", `${POLICY} não declara '${GUARDED}'`);
    emit(false, `${GUARDED} ausente da política`, 2);
  } else if (
    !/^\d+\.\d+\.\d+$/.test(String(min)) ||
    !/^\d+\.\d+\.\d+$/.test(String(max)) ||
    compareVersions(min, max) > 0
  ) {
    check("dependency-policy", "fail", `faixa inválida ou invertida: ${min} → ${max}`);
    emit(false, `faixa inválida em ${POLICY}`, 2);
  } else {
    check("dependency-policy", "pass", `${GUARDED} aprovado em ${min} → ${max}`);
    range = `${min}..${max}`;
  }

  const pkg = JSON.parse(pkgRaw);
  const spec = pkg?.devDependencies?.[GUARDED] ?? null;
  observed.spec = spec;
  const specBase = spec ? baseVersion(spec) : null;
  if (!spec) check("package-json-devdep", "fail", `devDependencies['${GUARDED}'] ausente`);
  else if (!specBase)
    check("package-json-devdep", "fail", `spec '${spec}' sem versão reconhecível`);
  else if (!inRange(specBase, min, max))
    check("package-json-devdep", "fail", `spec '${spec}' fora da faixa aprovada ${range}`);
  else check("package-json-devdep", "pass", `spec '${spec}'`);

  const lock = JSON.parse(lockRaw);
  const lockSpec = lock?.packages?.[""]?.devDependencies?.[GUARDED] ?? null;
  observed.lockSpec = lockSpec;
  if (lockSpec !== spec)
    check("lock-top-spec", "fail", `lock '${lockSpec}' != package.json '${spec}'`);
  else check("lock-top-spec", "pass", `lock '${lockSpec}'`);

  const resolved = lock?.packages?.[`node_modules/${GUARDED}`] ?? null;
  observed.lockResolvedVersion = resolved?.version ?? null;
  if (!resolved) check("lock-resolved", "fail", `entrada node_modules/${GUARDED} ausente no lock`);
  else if (!inRange(resolved.version ?? "", min, max))
    check("lock-resolved", "fail", `resolvido '${resolved.version}' fora da faixa ${range}`);
  else check("lock-resolved", "pass", `resolvido ${resolved.version}`);

  const lockSha = sha256(lockRaw);
  observed.lockSha256 = lockSha;
  let headLock = null;
  try {
    headLock = execFileSync("/usr/bin/git", ["show", `HEAD:${LOCK}`], {
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
    const nm = path.join("node_modules", GUARDED, "package.json");
    if (!existsSync(nm)) {
      check(
        "node-modules-installed",
        "skipped",
        `node_modules/${GUARDED} ausente (npm ci pendente)`,
      );
    } else {
      const installed = JSON.parse(readFileSync(nm, "utf8"))?.version ?? null;
      observed.installedVersion = installed;
      if (!inRange(installed ?? "", min, max))
        check("node-modules-installed", "fail", `instalado ${installed} fora da faixa ${range}`);
      else check("node-modules-installed", "pass", `instalado ${installed}`);
    }
  }

  emit(reasons.length === 0);
} catch (err) {
  check("guard-runtime", "fail", `erro interno: ${err?.message ?? String(err)}`);
  emit(false, String(err?.message ?? err));
}
